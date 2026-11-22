/**
 * @file seat-assessment.mjs — CKLST-B seat derivation, SHADOW by default; no GitHub IO.
 * Pure rule bodies below are vendored from core/verdict v0.1.2; the sole registration adaptation
 * omits inherited v0.1.1 rules. Exact source digest and every v0.1.2 rule vector are pinned in tests.
 * Adapter validation and immutable local reads follow the vendored section. Never read seat providers.
 * Call-site wiring and activation are deliberately separate from this library slice.
 */
import crypto from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { laneGitHardeningEnv, laneHistoryProofEnv, scrubGitRepoEnv } from './lane-git-hardening.mjs';
import { TRUST_CHAIN_BASENAMES, isTrustChainPath } from './gate-config.mjs';
import { GATE_PATTERNS, DEFAULT_SETTINGS_POLICY, isGateFile, resolveSettingsPolicy, logPolicyOnce,
  SETTINGS_READER_DIRS,
} from './merge-queue-affected.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { buildAcceptanceRubric } from './seat-ac-rubric.mjs';

export const RULES_SHA256 = 'bcb15ef4987a1dbe7adda7ff721385fcc82fedc82356e98d174da85b5ce8c3cf';
// BEGIN VENDORED core/verdict v0.1.2
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
  const base = {}; // Earlier-release registrations are outside this seat adapter.
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

// END VENDORED core/verdict v0.1.2


const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 512, MAX_EVIDENCE = 128, MAX_PATHS = 10000;
const httpsUri = { type: 'string', format: 'uri', pattern: '^https://[^\\s]+$' };


/** core/evidence v0.1 evidenceRef, with its local digestSet/provenanceTier refs inlined.
 * Kept separate from rubric refs: exact digests, kind and provenance are required, URI is optional.
 * Parity with the pinned schema is checked in seat-assessment.test.mjs.
 */
export const SEAT_EVIDENCE_REF_SCHEMA = {
  "description": "[CORE-EVD-012] How a verdict cites evidence: digest of the exact input examined plus its tier. A URI alone is never evidence.",
  "type": "object",
  "required": [
    "kind",
    "digest",
    "provenanceTier"
  ],
  "properties": {
    "kind": {
      "type": "string",
      "minLength": 1
    },
    "uri": {
      "type": "string",
      "format": "uri-reference"
    },
    "digest": {
      "description": "[CORE-EVD-002] in-toto DigestSet. Known algorithms must have their full hex length (local rule).",
      "type": "object",
      "minProperties": 1,
      "propertyNames": {
        "type": "string",
        "pattern": "^[a-z][a-zA-Z0-9]*$"
      },
      "properties": {
        "sha256": {
          "type": "string",
          "pattern": "^[0-9a-fA-F]{64}$"
        },
        "sha384": {
          "type": "string",
          "pattern": "^[0-9a-fA-F]{96}$"
        },
        "sha512": {
          "type": "string",
          "pattern": "^[0-9a-fA-F]{128}$"
        },
        "sha1": {
          "type": "string",
          "pattern": "^[0-9a-fA-F]{40}$"
        },
        "gitCommit": {
          "type": "string",
          "pattern": "^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$"
        },
        "gitTree": {
          "type": "string",
          "pattern": "^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$"
        },
        "gitBlob": {
          "type": "string",
          "pattern": "^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$"
        }
      },
      "additionalProperties": {
        "type": "string",
        "pattern": "^[0-9a-fA-F]{16,}$"
      }
    },
    "provenanceTier": {
      "description": "[CORE-EVD-003] Closed trust rungs: probe > replayed > asserted (D7 Fork 3 a).",
      "enum": [
        "probe",
        "replayed",
        "asserted"
      ]
    },
    "subTier": {
      "type": "string",
      "format": "uri",
      "description": "[CORE-EVD-004] org sub-tier; never replaces provenanceTier"
    },
    "statement": {
      "description": "[CORE-EVD-002] in-toto DigestSet. Known algorithms must have their full hex length (local rule).",
      "type": "object",
      "minProperties": 1,
      "propertyNames": {
        "type": "string",
        "pattern": "^[a-z][a-zA-Z0-9]*$"
      },
      "properties": {
        "sha256": {
          "type": "string",
          "pattern": "^[0-9a-fA-F]{64}$"
        },
        "sha384": {
          "type": "string",
          "pattern": "^[0-9a-fA-F]{96}$"
        },
        "sha512": {
          "type": "string",
          "pattern": "^[0-9a-fA-F]{128}$"
        },
        "sha1": {
          "type": "string",
          "pattern": "^[0-9a-fA-F]{40}$"
        },
        "gitCommit": {
          "type": "string",
          "pattern": "^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$"
        },
        "gitTree": {
          "type": "string",
          "pattern": "^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$"
        },
        "gitBlob": {
          "type": "string",
          "pattern": "^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$"
        }
      },
      "additionalProperties": {
        "type": "string",
        "pattern": "^[0-9a-fA-F]{16,}$"
      }
    },
    "provEntity": {
      "type": "string",
      "format": "uri"
    },
    "native": {
      "type": "object",
      "description": "native fields of the bound norm, kept as-is (D7 R1)"
    }
  },
  "additionalProperties": false
};

const digestSchema = SEAT_EVIDENCE_REF_SCHEMA.properties.digest;
const rubricRefSchema = { type: 'object', required: ['uri', 'digest'],
  properties: { uri: httpsUri, digest: digestSchema }, additionalProperties: false };
const evidenceKindSchema = { enum: LADDER };
const policyLevels = ['company', 'org', 'team', 'repo'];

/** Shared optional response field: legacy findings-only answers remain valid. */
export const SEAT_ANSWERS_SCHEMA = {
  type: 'object', required: ['items'], additionalProperties: false, properties: {
    items: { type: 'array', maxItems: MAX_ITEMS, items: {
      type: 'object', required: ['itemId', 'outcome', 'evidence'], additionalProperties: false,
      properties: {
        itemId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' },
        outcome: { enum: ['pass', 'fail', 'n/a'] }, reason: { type: 'string', minLength: 1 },
        naCheck: { ...rubricRefSchema, required: ['uri', 'digest', 'result'], properties: { ...rubricRefSchema.properties, result: { enum: ['pass', 'fail', 'unknown'] } } },
        evidence: { type: 'array', maxItems: MAX_EVIDENCE, items: {
          type: 'object', required: ['kind'], additionalProperties: false, properties: {
            kind: { type: 'string', minLength: 1 }, revisionId: { type: 'string', pattern: '^[0-9a-f]{40}$' },
            note: { type: 'string' }, ref: SEAT_EVIDENCE_REF_SCHEMA,
            location: { type: 'object', required: ['uri', 'startLine'], additionalProperties: false, properties: {
              uri: { type: 'string', minLength: 1 }, startLine: { type: 'integer', minimum: 1, maximum: 1000000 },
              endLine: { type: 'integer', minimum: 1, maximum: 1000000 }, snippet: { type: 'string', minLength: 1, maxLength: MAX_BYTES },
            } },
          },
        } },
      },
    } },
  },
};
const ajv = addFormats(new Ajv({ allErrors: true, strict: false }));
const validAnswers = ajv.compile(SEAT_ANSWERS_SCHEMA);
const validAssessment = ajv.compile({
  type: 'object', required: ['_type', 'subject', 'predicateType', 'predicate'], additionalProperties: false,
  properties: {
    _type: { const: 'https://in-toto.io/Statement/v1' }, predicateType: { const: ASSESSMENT_T },
    subject: { type: 'array', minItems: 1, maxItems: 32, items: {
      type: 'object', required: ['name', 'digest'], properties: {
        name: { type: 'string', minLength: 1 }, digest: digestSchema,
      },
    } },
    predicate: { type: 'object', required: ['seat', 'rubric', 'policy', 'revisionId', 'evaluatedAt', 'items'], additionalProperties: false,
      properties: {
        seat: { type: 'object', required: ['lens', 'evaluator'], additionalProperties: false, properties: {
          lens: { type: 'string', minLength: 1 }, evaluator: httpsUri,
        } },
        rubric: rubricRefSchema, policy: rubricRefSchema, revisionId: { type: 'string', pattern: '^[0-9a-f]{40}$' },
        evaluatedAt: { type: 'string', minLength: 1 }, repositoryUri: httpsUri, items: SEAT_ANSWERS_SCHEMA.properties.items,
      },
    },
  },
});
const validRubric = ajv.compile({
  type: 'object', required: ['rubricType', 'id', 'version', 'items'], additionalProperties: false, properties: {
    rubricType: { const: 'https://everstandards.dev/core/rubric/v0.1' }, id: httpsUri,
    version: { type: 'string', minLength: 1 }, title: { type: 'string' }, appliesTo: digestSchema,
    items: { type: 'array', minItems: 1, maxItems: MAX_ITEMS,
      items: { type: 'object', required: ['id', 'text'], additionalProperties: false, properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' }, text: { type: 'string', minLength: 1 },
        minKind: evidenceKindSchema, naAllowed: { type: 'boolean' }, naWhen: rubricRefSchema,
        sourceId: { type: 'string', minLength: 1 }, source: { type: 'string', format: 'uri' },
      } } },
  },
});
const validPolicy = ajv.compile({
  type: 'object', required: ['policyType', 'id', 'level', 'seats'], additionalProperties: false, properties: {
    policyType: { const: 'https://everstandards.dev/core/rubric-policy/v0.1' }, id: httpsUri,
    parent: rubricRefSchema,
    level: { enum: policyLevels }, confirmations: { type: 'array', maxItems: MAX_ITEMS, items: {
      type: 'object', required: ['lens', 'setting', 'level', 'owner', 'policyDigest'], additionalProperties: false,
      properties: { lens: { type: 'string', minLength: 1 }, setting: { type: 'string', minLength: 1 },
        level: { enum: policyLevels }, owner: { type: 'string', minLength: 1, format: 'uri' },
        policyDigest: digestSchema, record: rubricRefSchema },
    } },
    seats: { type: 'array', minItems: 1, maxItems: 32, items: {
      type: 'object', required: ['lens'], additionalProperties: false,
      properties: {
        lens: { type: 'string', minLength: 1 }, rubric: rubricRefSchema, rubricFrom: { const: 'subject' },
        required: { anyOf: [{ const: 'all' }, { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } }] },
        na: { type: 'object', additionalProperties: false, properties: {
          allowed: { type: 'boolean' }, neverNa: { type: 'array', uniqueItems: true, items: { type: 'string' } }, max: { type: 'integer', minimum: 0 },
        } },
        evidence: { type: 'object', additionalProperties: false, properties: {
          minKind: evidenceKindSchema, perItem: { type: 'object', additionalProperties: evidenceKindSchema },
        } },
        allNa: { enum: ['pass', 'unknown'] }, citeScope: { enum: ['tree', 'diff'] }, check: rubricRefSchema,
      },
      not: { required: ['rubric', 'rubricFrom'] },
    } },
  },
});
function requirePolicy(policy) {
  if (!validPolicy(policy) || new Set(policy.seats.map(s => s.lens)).size !== policy.seats.length)
    throw new Error('invalid rubric policy; repair plateau-settings review/rubric-policy');
}
function requireMode(mode) {
  if (!['shadow', 'enforce'].includes(mode?.mode) || !Number.isFinite(Date.parse(mode.shadowStartedAt))
    || !Number.isInteger(mode.maxDays) || mode.maxDays <= 0 || mode.maxDays > 7)
    throw new Error('invalid rubric mode or maxDays; repair plateau-settings review/rubric-mode.json and decide CKLST-B enforce');
}
function boundedJson(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (Buffer.byteLength(text ?? '') > MAX_BYTES) throw new Error('seat input exceeds 4 MiB; operator must review the full input and repair the seat source');
  return JSON.parse(text);
}
function safePath(path) {
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f\x7f\\:]/.test(path)
    || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error('invalid repo-relative citation/source path');
  return path;
}

/** IO: immutable blob read, no inherited git location/config, no filters, prompts or lazy network fetches. */
export function readHeadFile(head, path, { cwd = process.cwd(), exec = execFileSync, env = process.env } = {}) {
  if (!HEX40.test(head ?? '')) throw new Error('exact 40-hex head required');
  safePath(path);
  const hardened = laneGitHardeningEnv(scrubGitRepoEnv(env));
  hardened.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  return exec('git', ['-c', 'core.commitGraph=false', 'show', '--no-ext-diff', '--no-textconv', `${head}:${path}`],
    { cwd, env: hardened, encoding: 'utf8', timeout: 15000, maxBuffer: MAX_BYTES });
}

/** IO: the actual three-dot path set; no-renames includes the old and new path of a move. */
export function readDiffPaths(base, head, { cwd = process.cwd(), exec = execFileSync, env = process.env } = {}) {
  if (!HEX40.test(base ?? '') || !HEX40.test(head ?? '')) throw new Error('exact base and head required for merge-path check');
  const hardened = laneHistoryProofEnv(scrubGitRepoEnv(env));
  hardened.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  const options = { cwd, env: hardened, encoding: 'utf8', timeout: 15000, maxBuffer: MAX_BYTES };
  const root = String(exec('git', ['rev-parse', '--show-toplevel'], options)).trim();
  if (!root || /[\x00-\x1f\x7f]/.test(root)) throw new Error('cannot resolve repository root; operator must review the full diff');
  const output = String(exec('git', ['-c', 'core.commitGraph=false', '-c', 'diff.relative=false',
    'diff', '--no-relative', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', `${base}...${head}`, '--'],
  { ...options, cwd: root }));
  if (Buffer.byteLength(output) > MAX_BYTES) throw new Error('diff exceeds 4 MiB; operator must review the full diff');
  const paths = output.split('\0'); if (paths.at(-1) === '') paths.pop();
  if (paths.length > MAX_PATHS) throw new Error('diff exceeds 10000 paths; operator must review the full diff');
  return paths.map(safePath);
}

/** The executable definition references the EXISTING merge/review classifiers, never a second path list.
 * The concrete registry and merge-gate configuration are part of the digest, so changing either repins the check.
 */
const sourceDigest = relative => ({ sha256: crypto.createHash('sha256')
  .update(readFileSync(new URL(relative, import.meta.url))).digest('hex') });
export const MERGE_PATH_CHECK_DEFINITION = Object.freeze({
  uri: 'https://github.com/plateauapp/plateau-settings/blob/main/review/checks/diff-touches-no-merge-path',
  version: '2026-11-22.4', range: 'base...head',
  operation: 'refuse all scripts, workflows, settings-reader directories and settings-named paths, plus built-in/configured gates; include both rename sides',
  resolution: ['readDeclaredSettings', 'resolveSettingsPolicy'],
  conservativeReaderDirectories: SETTINGS_READER_DIRS,
  classifiers: [
    { module: 'scripts/lib/gate-config.mjs', export: 'isTrustChainPath', sourceDigest: sourceDigest('./gate-config.mjs'), basenames: [...TRUST_CHAIN_BASENAMES].sort() },
    { module: 'scripts/lib/merge-queue-affected.mjs', export: 'isGateFile', sourceDigest: sourceDigest('./merge-queue-affected.mjs'),
      patterns: GATE_PATTERNS.map(String), settingsPolicy: DEFAULT_SETTINGS_POLICY },
    { module: 'scripts/readiness/test-selection.mjs', export: 'isLocalFullSuiteTrigger',
      sourceDigest: sourceDigest('../readiness/test-selection.mjs') },
    { module: 'scripts/lib/settings-files.mjs', export: 'readDeclaredSettings', sourceDigest: sourceDigest('./settings-files.mjs') },
    { module: 'scripts/lib/seat-assessment.mjs', export: 'mergePathNaCheck', sourceDigest: sourceDigest('./seat-assessment.mjs') },
  ],
});

/** IO: the merge gate's configured policy, with its error diagnostics retained rather than defaulted away. */
function readGatePolicy({ env, readGateSettings, settingsLog, loggedGatePolicies }) {
  const declared = boundedJson(readGateSettings());
  if (!declared || typeof declared !== 'object' || !declared.settings || typeof declared.settings !== 'object'
    || Array.isArray(declared.settings) || !Array.isArray(declared.errors ?? []) || declared.errors?.length)
    throw new Error('configured gate settings unreadable; repair the declared settings');
  if (declared.duplicates !== undefined && (!Array.isArray(declared.duplicates) || declared.duplicates.length))
    throw new Error('duplicate or unreadable gate-setting ownership; repair the declared settings');
  const fresh = declared.settings.mergeFreshness;
  if (fresh !== undefined && (!fresh || typeof fresh !== 'object' || Array.isArray(fresh)))
    throw new Error('malformed gate-relevant mergeFreshness container; repair the declared settings');
  const policy = resolveSettingsPolicy({ env, declared });
  if (policy.errors.length) throw new Error('configured gate policy resolution failed; repair settings/env overrides');
  if (policy.gateFiles.length > MAX_PATHS) throw new Error('configured gate policy exceeds 10000 globs; review the full configuration');
  logPolicyOnce(policy, settingsLog, loggedGatePolicies);
  return policy;
}

/** PURE: a conservative superset of gate code, including every directory the shared reader can search.
 * Settings changes never get a key/value comparison exemption: their presence in base...head is enough.
 */
function isConservativeMergePath(path) {
  return path === 'scripts' || path.startsWith('scripts/') || path === '.github' || path.startsWith('.github/')
    || SETTINGS_READER_DIRS.some(dir => path === dir || path.startsWith(`${dir}/`))
    || /(^|\/)[^/]*settings[^/]*(\/|$)/i.test(path);
}

/** Exact immutable range required. Supplied arrays never establish provenance: always re-read base...head.
 * Configured gate policy augments built-ins and the conservative script/workflow/settings refusal.
 * Injected readers are trusted runner IO seams, never assessment-authored data.
 */
export function mergePathNaCheck({ base, head, diffPaths, readDiff, readGateSettings = readDeclaredSettings,
  settingsLog, loggedGatePolicies, ...gitOptions } = {}) {
  const ref = { uri: MERGE_PATH_CHECK_DEFINITION.uri, digest: digestOf(MERGE_PATH_CHECK_DEFINITION) };
  try {
    if (!HEX40.test(base ?? '') || !HEX40.test(head ?? '')) throw new Error('exact base and head required');
    const policy = readGatePolicy({ env: gitOptions.env ?? process.env, readGateSettings, settingsLog, loggedGatePolicies });
    diffPaths = (readDiff ?? ((b, h) => readDiffPaths(b, h, gitOptions)))(base, head);
    if (!Array.isArray(diffPaths) || !diffPaths.length || diffPaths.length > MAX_PATHS) throw new Error('missing or oversized net diff');
    if (Buffer.byteLength(JSON.stringify(diffPaths)) > MAX_BYTES) throw new Error('oversized net diff paths');
    const paths = diffPaths.map(safePath);
    const touched = paths.find(path => isConservativeMergePath(path)
      || isTrustChainPath(path) || isGateFile(path) || isGateFile(path, policy));
    return { ...ref, result: touched ? 'fail' : 'pass', diffPaths: paths,
      problems: touched ? [`merge-path n/a refused: diff touches ${touched}`] : [] };
  } catch (error) {
    return { ...ref, result: 'fail', problems: [`merge-path check failed: ${error.message}; operator must review the full diff and rerun`] };
  }
}

/** CORE-VRD-048 adapter guards beyond the frozen vendor: no authenticated approval source exists here.
 * Strip every child-authored confirmation before the Core cascade check; such claims never authorise relaxation.
 * Compare effective item floors (including inherited globals), and retain parent gate checks as well.
 */
function seatCascadeProblems(chain) {
  const problems = cascadeProblems(chain.map(policy => ({ ...policy, confirmations: [] })));
  for (let i = 1; i < chain.length; i++) {
    const child = chain[i], ancestors = chain.slice(0, i);
    for (const seat of child.seats) {
      const configuring = ancestors.filter(policy => policy.seats.some(parent => parent.lens === seat.lens));
      const parent = configuring.at(-1)?.seats.find(parent => parent.lens === seat.lens);
      if (!parent) continue;
      const levels = configuring.map(policy => policy.level);
      if (parent.check && !sameRef(parent.check, seat.check))
        problems.push(`${child.level} loosens ${seat.lens}.check without confirmation from ${levels.join(', ')}`);
      const ids = new Set([...Object.keys(parent.evidence?.perItem ?? {}), ...Object.keys(seat.evidence?.perItem ?? {})]);
      for (const id of ids) {
        const minimum = parent.evidence?.perItem?.[id] ?? parent.evidence?.minKind ?? 'assertion';
        const effective = seat.evidence?.perItem?.[id] ?? seat.evidence?.minKind ?? 'assertion';
        if (!meets(effective, minimum))
          problems.push(`${child.level} loosens ${seat.lens}.evidence.perItem.${id} without confirmation from ${levels.join(', ')}`);
      }
    }
  }
  return [...new Set(problems)].map(problem => `${problem}; child confirmations ignored: no authenticated approval-record source; retain the parent policy`);
}

/** IO: explicit settings checkout; company → optional explicitly named descendant policies (D15).
 * No policy becomes effective merely because shadow derivation reads it. Return provenance with every load.
 */
export function readSeatSettings({ settingsPath, read = readFileSync,
  policyPaths = ['rubric-policy/company.json'], log = () => {} } = {}) {
  const problems = [], sources = {}, chain = [];
  let mode, securityRubric, policy, modeValid = false;
  const load = relative => {
    if (!settingsPath) throw new Error('plateau-settings checkout path required');
    safePath(relative);
    const path = join(settingsPath, 'review', relative);
    sources[relative] = path;
    return boundedJson(String(read(path, 'utf8')));
  };
  try { mode = load('rubric-mode.json'); requireMode(mode); modeValid = true; }
  catch (error) { problems.push(`mode unreadable: ${error.message}; repair rubric-mode.json before enforcement`); }
  try {
    if (!Array.isArray(policyPaths) || !policyPaths.length || policyPaths.length > 4) throw new Error('invalid policy cascade');
    for (const path of policyPaths) { const p = load(path); requirePolicy(p); chain.push(p); }
    if (chain[0].level !== 'company') throw new Error('company policy required first');
    for (let i = 1; i < chain.length; i++) {
      const parent = chain[i - 1], child = chain[i];
      if (policyLevels.indexOf(child.level) <= policyLevels.indexOf(parent.level)
        || !sameRef(child.parent, { uri: parent.id, digest: digestOf(parent) }))
        throw new Error('missing or stale parent policy binding; repair the policy cascade');
    }
    const bad = seatCascadeProblems(chain); if (bad.length) throw new Error(bad.join('; '));
    const seats = new Map(); for (const p of chain) for (const seat of p.seats) seats.set(seat.lens, seat);
    policy = { ...chain.at(-1), seats: [...seats.values()] };
    securityRubric = load('rubrics/security.rubric.json');
    if (!validRubric(securityRubric)) throw new Error('invalid security rubric');
  } catch (error) { problems.push(`policy unreadable: ${error.message}; repair plateau-settings review files`); }
  try { log({ policy: 'seat-checklist', mode: mode?.mode ?? 'unknown', sources, problems }); }
  catch (error) { problems.push(`settings provenance log failed: ${error.message}`); }
  return { ...mode, modeValid, policy, securityRubric, sources, problems };
}

/** The executed seat gate, including adapter validation; policy checks must name these exact bytes. */
export const SEAT_GATE_CHECK_REF = Object.freeze({
  uri: 'https://everstandards.dev/core/checks/seat-gate/v0.1.2',
  digest: digestOf({ rules: RULES_SHA256, adapter: sourceDigest('./seat-assessment.mjs') }),
});

const refused = (problems, reason = 'missing') => ({ derived: 'unknown', reason, problems, gateOutcome: 'not-pass' });

/** PURE: bind a compact runner answer to the tool's pinned head, rubric and policy. */
export function wrapSeatAnswers({ lens, head, rubric, policy, answers, at, naCheck }) {
  if (!validAnswers(answers) || !HEX40.test(head ?? '') || !Number.isFinite(Date.parse(at)))
    throw new Error('invalid runner assessment, head or evaluatedAt');
  const items = answers.items.map(a => {
    const item = rubric.items.find(item => item.id === a.itemId);
    const answer = { ...a, evidence: a.evidence.map(e => ({ ...e, revisionId: e.revisionId ?? head })) };
    if (a.outcome === 'n/a' && item?.naWhen) {
      if (!naCheck || !sameRef(naCheck, item.naWhen)) throw new Error('naWhen check definition is stale; repin the rubric');
      const recorded = { uri: naCheck.uri, digest: naCheck.digest, result: naCheck.result };
      if (a.naCheck && (!sameRef(a.naCheck, recorded) || a.naCheck.result !== recorded.result))
        throw new Error('naCheck claim disagrees with the computed merge-path result (CORE-VRD-054)');
      answer.naCheck = recorded;
    }
    return answer;
  });
  return { _type: 'https://in-toto.io/Statement/v1', subject: [{ name: 'review-head', digest: { gitCommit: head } }],
    predicateType: ASSESSMENT_T, predicate: { seat: { lens, evaluator: 'https://everstandards.dev/core/evaluators/seat-runner' },
      rubric: { uri: rubric.id, digest: digestOf(rubric) }, policy: { uri: policy.id, digest: digestOf(policy) },
      revisionId: head, evaluatedAt: at, items } };
}

/** PURE apart from injected immutable citation reads. Only the runner's assessment argument is consumed.
 * assessmentRunId is required provenance retained by the runner alongside these exact answers, outside
 * the closed Core Statement. Never infer it from the current runId or from assessment-authored fields.
 */
export function evaluateSeat({ lens, head, runId, assessmentRunId, assessment, rubric, expectedRubric,
  policy, settings, diffPaths, readFileAtHead, cwd, env, at, base, readDiff,
  readGateSettings, settingsLog, loggedGatePolicies } = {}) {
  try {
    if (settings && (settings.modeValid === false || !['shadow', 'enforce'].includes(settings.mode)))
      return refused([...(settings.problems ?? []), 'configured mode unreadable or invalid; repair rubric-mode.json']);
    if (settings?.problems?.length) return refused([...settings.problems]);
    policy ??= settings?.policy;
    requirePolicy(policy);
    if (!['security', 'correctness'].includes(lens) || !HEX40.test(head ?? '')
      || typeof runId !== 'string' || !runId.trim()
      || typeof assessmentRunId !== 'string' || !assessmentRunId.trim() || assessmentRunId !== runId)
      return refused(['missing or stale head, mandatory lens, or review run binding'], 'stale');
    const seat = policy.seats.find(s => s.lens === lens);
    if (!seat || (!seat.rubric && seat.rubricFrom !== 'subject')) return refused([`${lens}: no rubric policy`]);
    if (seat.check && !sameRef(seat.check, SEAT_GATE_CHECK_REF)) return refused(['unknown or stale seat.check; repin to the executed seat gate'], 'stale');
    if (!rubric) return refused([lens === 'correctness' ? 'no pinned acceptance' : 'no pinned security rubric']);
    if (!validRubric(rubric) || new Set(rubric.items.map(i => i.id)).size !== rubric.items.length)
      return refused(['invalid or duplicate rubric items']);
    if (lens === 'correctness' && (!expectedRubric || canonical(rubric) !== canonical(expectedRubric)))
      return refused(['correctness rubric differs from pinned merge-base acceptance'], 'stale');
    if (!assessment) return refused(['no assessment']);
    assessment = boundedJson(assessment);
    const answers = assessment.predicateType ? assessment.predicate?.items : assessment.items;
    let naCheck;
    const adapterProblems = [];
    const conditional = Array.isArray(answers) ? answers.filter(a => a.outcome === 'n/a'
      && (rubric.items.find(item => item.id === a.itemId)?.naWhen || /^MP\d+$/.test(a.itemId))) : [];
    if (conditional.length) {
      // Registry currently has one offline check. URI AND digest must match; claims never execute themselves.
      naCheck = mergePathNaCheck({ base, head, diffPaths, readDiff, cwd, env,
        readGateSettings, settingsLog, loggedGatePolicies });
      diffPaths = naCheck.diffPaths;
      for (const answer of conditional) {
        const condition = rubric.items.find(item => item.id === answer.itemId)?.naWhen;
        if (condition && !sameRef(condition, naCheck))
          return refused(['unknown or stale naWhen definition digest; repin the rubric and policy to a registered check'], 'stale');
        if (condition && assessment.predicateType && (!sameRef(answer.naCheck, naCheck) || answer.naCheck?.result !== naCheck.result))
          adapterProblems.push(`${answer.itemId}: naCheck differs from independently executed check (CORE-VRD-054)`);
      }
      adapterProblems.push(...naCheck.problems);
    }
    // A runner's compact answer is bound here; a full Statement must retain and prove its original binding.
    if (!assessment.predicateType) assessment = wrapSeatAnswers({ lens, head, rubric, policy, answers: assessment, at, naCheck });
    const p = assessment.predicate;
    if (!validAssessment(assessment) || !Number.isFinite(Date.parse(p?.evaluatedAt))) return refused(['invalid assessment Statement or items']);
    if (p.revisionId !== head || commitOf(assessment) !== head) return refused(['assessment is not at this reviewed head'], 'stale');
    if (['verdict', 'reason', 'disposition'].some(key => Object.hasOwn(p, key))) return refused(['assessment cannot declare its own aggregate']);
    if (!sameRef(p.policy, { uri: policy.id, digest: digestOf(policy) })) return refused(['assessment policy differs from pinned policy'], 'stale');
    const derived = deriveSeat({ seat, rubric, assessment });
    const problems = [...adapterProblems, ...derived.problems];
    const ids = p.items.map(a => a.itemId);
    if (ids.length !== new Set(ids).size || ids.some(id => !rubric.items.some(i => i.id === id))) problems.push('duplicate or unknown answer item');
    const read = readFileAtHead ?? ((rev, path) => readHeadFile(rev, path, { cwd, env }));
    const tree = {};
    for (const a of p.items) for (const e of a.evidence ?? []) {
      // No offline resolver can establish a test's success, provenance and reviewed head from a digest alone.
      if (e.kind === 'verified-test') problems.push(`${a.itemId}: unresolved verified-test evidence; cite the reviewed tree or rerun with a trusted offline resolver`);
      if (!e.location) continue;
      if (e.revisionId !== head) problems.push(`${a.itemId}: citation has no exact reviewed head`);
      const location = e.location, path = safePath(location.uri);
      if ((location.endLine ?? location.startLine) - location.startLine > 10000)
        throw new Error('citation range exceeds 10000 lines; operator must review the full evidence');
      if (!Object.hasOwn(tree, path)) {
        const text = String(read(head, path));
        if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('citation file exceeds 4 MiB; operator must review full evidence');
        tree[path] = Object.fromEntries(text.split('\n').map((line, i) => [i + 1, line]));
      }
    }
    problems.push(...citationProblems({ assessment, tree, diffPaths, citeScope: seat.citeScope }));
    // The aggregate is tool-owned and references the exact answers just checked, never an asserted PR comment.
    const verdict = { _type: 'https://in-toto.io/Statement/v1', subject: assessment.subject, predicateType: VERDICT_T,
      predicate: { verdict: derived.verdict, ...(derived.reason ? { reason: derived.reason } : {}),
        policy: p.policy, evaluatedAt: p.evaluatedAt, evaluator: p.seat.evaluator, examined: derived.examined,
        evidence: [{ kind: ASSESSMENT_T, uri: 'assessment.json', digest: digestOf(assessment), provenanceTier: 'replayed' }] } };
    const gate = seatGate({ seat, rubric, assessment, verdict, validVerdict: v => ['pass', 'fail', 'unknown'].includes(v.predicate.verdict) });
    return { derived: problems.length && derived.verdict === 'pass' ? 'unknown' : derived.verdict,
      reason: derived.reason ?? (problems.length ? 'missing' : null), problems,
      gateOutcome: problems.length ? 'not-pass' : gate.outcome };
  } catch (error) { return refused([`seat derivation failed: ${error.message}; repair evidence and rerun the seat`]); }
}

/** Omitted mode keeps the library's shadow default; an explicit invalid value never selects a default. */
function invalidRequestedMode(options) {
  return Object.hasOwn(options, 'mode') && !['shadow', 'enforce'].includes(options.mode);
}
function effectiveMode(settings, requested, invalidRequested = false) {
  if (invalidRequested) return 'enforce';
  if (settings) return settings.modeValid !== false && ['shadow', 'enforce'].includes(settings.mode) ? settings.mode : 'enforce';
  return ['shadow', 'enforce'].includes(requested) ? requested : 'shadow';
}

/** IO boundary: append AFTER derivation. Shadow failures remain visible and can never turn into a pass. */
export function assessSeat(options = {}) {
  const at = options.at ?? new Date().toISOString();
  const invalidMode = invalidRequestedMode(options);
  let result = invalidMode ? refused(['invalid requested rubric mode; choose shadow or enforce and rerun'])
    : evaluateSeat({ ...options, at });
  const mode = effectiveMode(options.settings, options.mode, invalidMode);
  if ((mode === 'shadow' || options.mode === 'shadow' || options.shadowRequested) && (options.appendRow || options.shadowPath)) {
    const started = options.settings?.shadowStartedAt ?? options.shadowStartedAt;
    const days = options.settings?.maxDays ?? options.maxDays;
    const row = { pr: options.pr, head: options.head, lens: options.lens, ...result,
      liveVerdict: options.liveVerdict, at, runId: options.runId };
    if (started !== undefined || days !== undefined) {
      try {
        requireMode({ mode, shadowStartedAt: started, maxDays: days });
        if (!Number.isFinite(Date.parse(at))) throw new Error('invalid shadow row time');
        if (Date.parse(at) >= Date.parse(started) + days * 86400000) {
          row.expired = true; row.problems = [...row.problems, 'decide CKLST-B enforce'];
        }
      } catch (error) { result = refused([...result.problems, error.message]); Object.assign(row, result); }
    }
    try {
      if (options.appendRow) options.appendRow(row);
      else appendFileSync(options.shadowPath, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) { result = refused([...result.problems, `shadow append failed: ${error.message}`]); }
  }
  return { ...result, runId: options.runId, head: options.head };
}

/** Orchestrator seam, still unwired: shadow NEVER supplies seatGates to the panel reducer.
 * assessmentRunIds is the runner's retained per-lens provenance; missing entries refuse that seat.
 */
export function assessReviewSeats(options = {}) {
  const settings = options.settings ?? (options.settingsPath ? readSeatSettings(options) : undefined);
  const invalidMode = invalidRequestedMode(options);
  const mode = effectiveMode(settings, options.mode, invalidMode);
  const read = options.readFileAtRevision ?? ((revision, path) => readHeadFile(revision, path, options));
  let correctness = options.expectedRubric, preparationProblems = [];
  if (correctness === undefined && options.mergeBase) {
    try { correctness = buildAcceptanceRubric({ ...options, readFileAtRevision: read }); }
    catch (error) { preparationProblems.push(`pinned acceptance unreadable: ${error.message}`); }
  }
  const seats = {};
  for (const lens of ['security', 'correctness']) {
    const localSettings = preparationProblems.length && lens === 'correctness'
      ? { ...settings, problems: [...(settings?.problems ?? []), ...preparationProblems] } : settings;
    seats[lens] = assessSeat({ ...options, settings: localSettings, mode: invalidMode ? options.mode : mode, shadowRequested: options.mode === 'shadow', lens,
      rubric: lens === 'correctness' ? correctness : (options.rubrics?.security ?? settings?.securityRubric),
      expectedRubric: correctness, assessment: options.assessments?.[lens] ?? null,
      assessmentRunId: options.assessmentRunIds?.[lens] });
  }
  return { seats, ...(mode === 'enforce' ? { seatGates: Object.fromEntries(Object.entries(seats).map(([lens, seat]) => [lens, seat.gateOutcome])) } : {}) };
}
