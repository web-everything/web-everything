// Cross-field rules added by core/verdict v0.1.2 (review.acceptOnChecklist): checklist-based seat accepts.
// Pure functions: the seat derivation, the seat gate, citation checks, the D15 cascade (tighten free, loosen confirmed)
// and the outward item mappings. Loaded by tools-v0.1/validate.mjs for this release; tools/verify-live.mjs reuses them.
// Each rule returns [] (ok) or a list of problems. Read-only.
import crypto from 'node:crypto';
import { makeRules as makeRules011 } from '../v0.1.1/rules.mjs';

export const ASSESSMENT_T = 'https://everstandards.dev/core/assessment/v0.1';
const VERDICT_T = 'https://everstandards.dev/core/verdict/v0.1';
const LADDER = ['assertion', 'resolved-citation', 'repro', 'quoted-citation', 'verified-test']; // CORE-VRD-035, lowest first
const HEX40 = /^[0-9a-f]{40}$/;

// Canonical JSON (object keys sorted, no whitespace): the same local rule as ship/planning-forecast (RFC 8785 binding owed, G9).
export const canonical = (x) => Array.isArray(x) ? `[${x.map(canonical).join(',')}]`
  : x && typeof x === 'object' ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}` : JSON.stringify(x);
export const digestOf = (x) => ({ sha256: crypto.createHash('sha256').update(canonical(x)).digest('hex') });
const sameDigest = (a, b) => !!a && !!b && Object.keys(a).length > 0 && Object.entries(a).every(([k, v]) => b[k] === v) && Object.keys(a).length === Object.keys(b).length;
const sameRef = (a, b) => a?.uri === b?.uri && sameDigest(a?.digest, b?.digest);
// A kind meets a minimum only by the ladder; an x- or URI kind meets only an identical minimum (fails closed).
export const meets = (kind, min) => { if (!min) return true; const k = LADDER.indexOf(kind ?? 'assertion'), m = LADDER.indexOf(min); return m < 0 ? kind === min : k >= m; };
const commitOf = (stmt) => (stmt?.subject ?? []).map((s) => s?.digest?.gitCommit).find((c) => typeof c === 'string');

/** Check one item answer's evidence (CORE-VRD-041). Returns a list of problems; any problem makes the answer invalid. */
export function evidenceProblems(item, { revisionId, minKind, naWhen }) {
  const out = [], ev = item.evidence ?? [];
  const cited = ev.some((e) => e.location && e.revisionId === revisionId); // a {file, line, head} citation (CORE-VRD-055)
  if (item.outcome === 'fail' && !cited) out.push(`${item.itemId}: fail without a cited {file, line, head} (CORE-VRD-055)`);
  if (item.outcome === 'n/a' && naWhen) { // CORE-VRD-054/055: a conditional n/a needs its check to hold and a citation
    if (!cited) out.push(`${item.itemId}: n/a on an item with naWhen carries no cited {file, line, head} (CORE-VRD-055)`);
    const c = item.naCheck;
    if (!c || !sameRef(c, naWhen)) out.push(`${item.itemId}: n/a without the result of its naWhen check (CORE-VRD-054)`);
    else if (c.result !== 'pass') out.push(`${item.itemId}: naWhen check result is ${c.result}, not pass (CORE-VRD-054)`);
  }
  if (item.outcome === 'pass' && !ev.length) out.push(`${item.itemId}: pass with no evidence`);
  if (item.outcome !== 'pass' && !item.reason) out.push(`${item.itemId}: ${item.outcome} with no reason`);
  if (ev.length && !ev.some((e) => meets(e.kind, minKind))) out.push(`${item.itemId}: no evidence at or above ${minKind}`);
  for (const e of ev) {
    if (e.revisionId !== undefined && e.revisionId !== revisionId) out.push(`${item.itemId}: evidence revision ${e.revisionId} is not the reviewed head`);
    if (e.kind === 'quoted-citation' && !(e.location && typeof e.location.snippet === 'string')) out.push(`${item.itemId}: quoted-citation without a snippet`);
    if (['resolved-citation', 'quoted-citation'].includes(e.kind) && !e.location) out.push(`${item.itemId}: ${e.kind} without a location`);
    if (e.kind === 'verified-test' && !e.ref) out.push(`${item.itemId}: verified-test without an evidence reference`);
  }
  return out;
}

/**
 * Derive one seat's verdict from its assessment (CORE-VRD-042). Never trusts the seat's own aggregate.
 * seat: the effective policy entry for the lens; rubric: the rubric document; assessment: the Statement.
 * Returns { verdict, reason?, examined: {count, unit:'criteria'}, problems }.
 */
export function deriveSeat({ seat, rubric, assessment }) {
  const problems = [], unk = (reason) => ({ verdict: 'unknown', reason, examined: { count: 0, unit: 'criteria' }, problems });
  const p = assessment?.predicate;
  if (!p || assessment.predicateType !== ASSESSMENT_T || !Array.isArray(p.items)) { problems.push('no assessment'); return unk('missing'); }
  if (p.seat?.lens !== seat.lens) { problems.push(`assessment lens ${p.seat?.lens} is not ${seat.lens}`); return unk('missing'); }
  const head = commitOf(assessment);
  if (!HEX40.test(p.revisionId ?? '') || p.revisionId !== head) { problems.push('revisionId is not the subject gitCommit'); return unk('stale'); }
  if (!rubric || !sameRef(p.rubric, { uri: rubric.id, digest: digestOf(rubric) })) { problems.push('assessment rubric is not the pinned rubric'); return unk('stale'); }
  if (seat.rubric && !sameRef(seat.rubric, p.rubric)) { problems.push('rubric differs from the policy rubric'); return unk('stale'); }
  if (seat.rubricFrom === 'subject' && !(rubric.appliesTo && (assessment.subject ?? []).some((s) => sameDigest(rubric.appliesTo, s.digest)))) { problems.push('subject AC rubric does not apply to this subject'); return unk('stale'); }
  const ids = rubric.items.map((i) => i.id);
  const required = seat.required === 'all' || seat.required === undefined ? ids : seat.required;
  if (!required.length || required.some((id) => !ids.includes(id))) { problems.push('required set empty or names an item the rubric lacks'); return unk('missing'); }
  const na = seat.na ?? { allowed: false }, neverNa = new Set([...(na.neverNa ?? []), ...rubric.items.filter((i) => i.naAllowed === false).map((i) => i.id)]);
  const state = {};
  for (const id of required) {
    const answers = p.items.filter((a) => a.itemId === id);
    if (answers.length !== 1) { state[id] = 'unknown'; problems.push(`${id}: ${answers.length ? 'answered twice' : 'unanswered'}`); continue; }
    const a = answers[0], item = rubric.items.find((i) => i.id === id);
    const minKind = seat.evidence?.perItem?.[id] ?? item.minKind ?? seat.evidence?.minKind;
    const bad = evidenceProblems(a, { revisionId: p.revisionId, minKind, naWhen: item.naWhen });
    if (a.outcome === 'n/a' && (!na.allowed || neverNa.has(id))) bad.push(`${id}: n/a not allowed`);
    if (bad.length) { state[id] = a.outcome === 'fail' ? 'fail' : 'unknown'; problems.push(...bad); continue; } // a fail never helps a pass
    state[id] = a.outcome;
  }
  const vals = Object.values(state), answered = vals.filter((v) => v !== 'unknown').length;
  const examined = { count: answered, unit: 'criteria' };
  if (vals.includes('fail')) return { verdict: 'fail', examined, problems }; // a known fail wins over a missing item
  if (vals.includes('unknown')) return { verdict: 'unknown', reason: 'missing', examined, problems };
  const nNa = vals.filter((v) => v === 'n/a').length;
  if (na.max !== undefined && nNa > na.max) { problems.push(`${nNa} n/a answers exceed the cap ${na.max}`); return { verdict: 'unknown', reason: 'inconclusive', examined, problems }; }
  if (nNa === vals.length && (seat.allNa ?? 'unknown') !== 'pass') { problems.push('every required item is n/a'); return { verdict: 'unknown', reason: 'inconclusive', examined, problems }; }
  return { verdict: 'pass', examined, problems };
}

/**
 * The seat gate (CORE-VRD-043/044/050/051/053): does this verdict satisfy a deciding seat under the effective policy?
 * With no rubric policy for the lens, the 0.1.1 gate semantics apply unchanged. With one, the verdict must cite the
 * assessment (kind = assessment type, digest = its canonical digest), match the derived verdict and examined count.
 */
export function seatGate({ seat, rubric, assessment, verdict, validVerdict }) {
  if (!verdict || verdict.predicateType !== VERDICT_T || !validVerdict(verdict)) return { outcome: 'not-pass', why: 'no valid verdict' };
  const v = verdict.predicate;
  if (!seat || (!seat.rubric && !seat.rubricFrom)) return { outcome: v.verdict === 'pass' && v.examined?.count >= 1 && v.evidence.length ? 'pass' : 'not-pass', why: 'no rubric for this lens' };
  const d = deriveSeat({ seat, rubric, assessment });
  const cites = assessment && v.evidence.some((e) => e.kind === ASSESSMENT_T && sameDigest(e.digest, digestOf(assessment)));
  if (!cites) return { outcome: 'not-pass', why: 'verdict does not cite its assessment (blank accept)', derived: d };
  if (commitOf(verdict) !== commitOf(assessment)) return { outcome: 'not-pass', why: 'verdict and assessment name different heads', derived: d };
  if (v.verdict !== d.verdict) return { outcome: 'not-pass', why: `verdict ${v.verdict} but items derive ${d.verdict}`, derived: d };
  if (v.verdict === 'pass' && (v.examined?.unit !== 'criteria' || v.examined.count !== d.examined.count)) return { outcome: 'not-pass', why: 'examined is not the answered criteria count', derived: d };
  return { outcome: d.verdict === 'pass' ? 'pass' : 'not-pass', why: d.problems.join('; ') || 'derived', derived: d };
}

/** Citation check against a tree snapshot { path: { line: text } } at the reviewed head (CORE-VRD-045). */
export function citationProblems({ assessment, tree, diffPaths, citeScope = 'tree' }) {
  const out = [];
  for (const a of assessment.predicate.items) for (const e of a.evidence ?? []) {
    if (!e.location) continue;
    const { uri, startLine, endLine, snippet } = e.location, file = tree[uri];
    if (!file) { out.push(`${a.itemId}: ${uri} is not in the head tree`); continue; }
    if (citeScope === 'diff' && !(diffPaths ?? []).includes(uri)) out.push(`${a.itemId}: ${uri} is outside the net diff`);
    const last = endLine ?? startLine; if (last < startLine) { out.push(`${a.itemId}: endLine before startLine`); continue; }
    const lines = []; for (let n = startLine; n <= last; n++) { if (file[n] === undefined) { out.push(`${a.itemId}: ${uri}:${n} does not exist`); break; } lines.push(file[n]); }
    if (typeof snippet === 'string' && lines.length === last - startLine + 1 && !lines.join('\n').includes(snippet)) out.push(`${a.itemId}: snippet does not match ${uri}:${startLine}`);
  }
  return out;
}

// D15 cascade (CORE-VRD-048): which settings a child seat loosens relative to its parent.
export function loosened(parent, child) {
  const out = [], pReq = parent.required === 'all' || parent.required === undefined ? null : parent.required, cReq = child.required === 'all' || child.required === undefined ? null : child.required;
  if (!sameRef(parent.rubric, child.rubric) && (parent.rubric || child.rubric)) out.push('rubric');
  if (parent.rubricFrom !== child.rubricFrom) out.push('rubricFrom');
  if (cReq && (!pReq || pReq.some((id) => !cReq.includes(id)))) out.push('required');
  const pn = parent.na ?? { allowed: false }, cn = child.na ?? { allowed: false };
  if (cn.allowed && !pn.allowed) out.push('na.allowed');
  if ((pn.neverNa ?? []).some((id) => !(cn.neverNa ?? []).includes(id))) out.push('na.neverNa');
  if (pn.max !== undefined && (cn.max === undefined || cn.max > pn.max) && cn.allowed) out.push('na.max');
  if ((child.allNa ?? 'unknown') === 'pass' && (parent.allNa ?? 'unknown') !== 'pass') out.push('allNa');
  if (!meets(child.evidence?.minKind ?? 'assertion', parent.evidence?.minKind)) out.push('evidence.minKind');
  for (const [id, k] of Object.entries(parent.evidence?.perItem ?? {})) if (!meets(child.evidence?.perItem?.[id] ?? child.evidence?.minKind ?? 'assertion', k)) out.push(`evidence.perItem.${id}`);
  if ((parent.citeScope ?? 'tree') === 'diff' && (child.citeScope ?? 'tree') !== 'diff') out.push('citeScope');
  return out;
}
const ORDER = ['company', 'org', 'team', 'repo'];
/** The digest a confirmation binds: the child policy without its confirmations (so the confirmation can sit inside it). */
export const policyDigest = (p) => { const { confirmations, ...rest } = p; return digestOf(rest); };
/** A chain of policies, top first: every loosening of a lens MUST carry a confirmation from each level it goes below. */
export function cascadeProblems(chain) {
  const out = [];
  for (let i = 1; i < chain.length; i++) {
    const child = chain[i];
    if (ORDER.indexOf(child.level) <= ORDER.indexOf(chain[i - 1].level)) out.push(`${child.level} does not sit below ${chain[i - 1].level}`);
    for (const cs of child.seats) {
      // compare with the nearest ancestor that configures the same lens
      const anc = chain.slice(0, i).reverse().map((p) => p.seats.find((s) => s.lens === cs.lens)).find(Boolean);
      if (!anc) continue;
      for (const path of loosened(anc, cs)) {
        const above = chain.slice(0, i).filter((p) => p.seats.some((s) => s.lens === cs.lens)).map((p) => p.level);
        const ok = above.every((lvl) => (child.confirmations ?? []).some((c) => c.lens === cs.lens && c.setting === path && c.level === lvl && c.owner && sameDigest(c.policyDigest, policyDigest(child))));
        if (!ok) out.push(`${child.level} loosens ${cs.lens}.${path} without confirmation from ${above.join(', ')}`);
      }
    }
  }
  return out;
}

// Outward mappings (CORE-VRD-049). unknown is any unanswered or invalid item. OSCAL 1.2.3 objective status has only satisfied | not-satisfied.
export const ITEM_MAP = {
  sarif: { pass: 'pass', fail: 'fail', 'n/a': 'notApplicable', unknown: 'open' },
  oscal: { pass: { state: 'satisfied', reason: 'pass' }, fail: { state: 'not-satisfied', reason: 'fail' }, 'n/a': null, unknown: null },
  testResult: { pass: 'passedTests', fail: 'failedTests', 'n/a': null, unknown: null },
};

export function makeRules(ctx) {
  const base = makeRules011(ctx);
  const v012 = ctx.ajv.getSchema('https://everstandards.dev/core/0.1.2/verdict.schema.json#/$defs/verdict');
  const validVerdict = (x) => v012(x);
  return {
    ...base,
    seatDerive: ({ seat, rubric, assessment, verdict: want, reason }) => {
      const d = deriveSeat({ seat, rubric, assessment });
      return d.verdict === want && (reason === undefined || d.reason === reason) ? [] : [`items derive ${d.verdict}${d.reason ? '/' + d.reason : ''}, vector claims ${want}${reason ? '/' + reason : ''} (CORE-VRD-042): ${d.problems.slice(0, 2).join('; ')}`];
    },
    seatGate: ({ seat, rubric, assessment, verdict, outcome }) => {
      const g = seatGate({ seat, rubric, assessment, verdict, validVerdict });
      return g.outcome === outcome ? [] : [`seat gate gives ${g.outcome} (${g.why}), vector claims ${outcome} (CORE-VRD-043)`];
    },
    itemsUnique: ({ assessment }) => {
      const ids = assessment.predicate.items.map((i) => i.itemId); return ids.length === new Set(ids).size ? [] : ['an item is answered twice (CORE-VRD-040)'];
    },
    itemEvidence: ({ assessment, minKind, rubric }) => assessment.predicate.items.flatMap((i) => evidenceProblems(i, { revisionId: assessment.predicate.revisionId, minKind, naWhen: rubric?.items.find((r) => r.id === i.itemId)?.naWhen })),
    rubricWellFormed: ({ rubric }) => { const ids = rubric.items.map((i) => i.id); return ids.length === new Set(ids).size ? [] : ['rubric item ids are not unique (CORE-VRD-046)']; },
    policyResolves: ({ policy, rubrics }) => policy.seats.flatMap((s) => {
      const r = s.rubric ? rubrics.find((x) => sameRef(s.rubric, { uri: x.id, digest: digestOf(x) })) : null;
      if (s.rubric && !r) return [`${s.lens}: rubric ref does not resolve to its digest (CORE-VRD-047)`];
      if (r && Array.isArray(s.required) && s.required.some((id) => !r.items.some((i) => i.id === id))) return [`${s.lens}: required names an item the rubric lacks (CORE-VRD-047)`];
      return [];
    }).concat(new Set(policy.seats.map((s) => s.lens)).size === policy.seats.length ? [] : ['a lens is configured twice (CORE-VRD-047)']),
    citations: (x) => citationProblems(x),
    cascade: ({ chain }) => cascadeProblems(chain),
    itemMapping: ({ rows }) => rows.flatMap((r) => {
      const want = ITEM_MAP[r.target]?.[r.outcome];
      if (want === undefined) return [`no mapping for ${r.target}/${r.outcome}`];
      if (want === null) return r.to === null && r.loss === true ? [] : [`${r.target}/${r.outcome} has no native value: it MUST be reported as loss, never mapped (CORE-VRD-049)`];
      return JSON.stringify(r.to) === JSON.stringify(want) ? [] : [`${r.target}/${r.outcome} → ${JSON.stringify(r.to)}, expected ${JSON.stringify(want)} (CORE-VRD-049)`];
    }),
  };
}
