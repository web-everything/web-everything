import { isGateFile } from '../merge-queue-affected.mjs';
// @vitest-environment node
/** CKLST-B: negative controls precede the seat gate implementation. Offline #7236 tree replay. */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { derivePanelVerdict } from '../jury-core.mjs';
import { TRUST_CHAIN, isTrustChainPath } from '../gate-config.mjs';
import { buildPanelMandate, REVIEW_SEAT_RESPONSE_SCHEMA } from '../review-core.mjs';
import { wrapSeatAnswers, assessSeat, assessReviewSeats, evaluateSeat, readSeatSettings, readHeadFile,
  deriveSeat, seatGate, digestOf, policyDigest, makeRules, RULES_SHA256, SEAT_EVIDENCE_REF_SCHEMA, mergePathNaCheck, readDiffPaths, MERGE_PATH_CHECK_DEFINITION } from '../seat-assessment.mjs';

const root = new URL('./fixtures/seat-checklist/', import.meta.url);
const json = p => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const clone = x => structuredClone(x);
const data = lens => Object.fromEntries(['assessment', 'rubric', 'policy'].map(k => [k, json(`live/7236-${lens}/${k}.json`)]));
const head = data('security').assessment.predicate.revisionId;
const tree = json('vectors/live-7236.tree.json');
const panel = { lensVerdicts: { security: 'accept', correctness: 'accept' }, findings: [] };
const input = lens => ({ ...data(lens), lens, head, runId: 'run-1', assessmentRunId: 'run-1', expectedRubric: data(lens).rubric,
  diffPaths: [], readFileAtHead: (_head, path) => Array.from({ length: Math.max(...Object.keys(tree[path]).map(Number)) }, (_, i) => tree[path][i + 1] ?? '').join('\n') });
const gatesFor = assessment => Object.fromEntries(['security', 'correctness'].map(lens => [lens,
  assessSeat({ ...input(lens), assessment: assessment === null ? null : data(lens).assessment, mode: 'enforce' }).gateOutcome]));

it("a mandatory seat's plain accept with no assessment is a failed seat under an enforced rubric policy", () => {
  expect(derivePanelVerdict({ ...panel, seatGates: gatesFor(null) })).toBe('changes');
  expect(derivePanelVerdict({ ...panel, seatGates: gatesFor('7236') })).toBe('accept');
});

const mutations = [
  ['missing item', x => x.assessment.predicate.items.shift()],
  ['item answered twice', x => x.assessment.predicate.items.push(clone(x.assessment.predicate.items[0]))],
  ['pass with no evidence', x => x.assessment.predicate.items[0].evidence = []],
  ['snippet mismatch', x => x.assessment.predicate.items[0].evidence[0].location.snippet = 'NO SUCH LINE'],
  ['citation with no bound head', x => delete x.assessment.predicate.items[0].evidence[0].revisionId],
  ['missing evaluator', x => delete x.assessment.predicate.seat.evaluator],
  ['evidence at another head', x => x.assessment.predicate.items[0].evidence[0].revisionId = 'b'.repeat(40)],
  ['n/a on SB1', x => Object.assign(x.assessment.predicate.items[0], { outcome: 'n/a', reason: 'not relevant' })],
  ['MP n/a on a diff touching a merge-path file', x => x.diffPaths = ['scripts/lib/gate-config.mjs']],
  ['unknown item outcome', x => x.assessment.predicate.items[0].outcome = 'anything'],
  ['invalid citation line', x => x.assessment.predicate.items[0].evidence[0].location.startLine = 0],
  ['citation read throws', x => x.readFileAtHead = () => { throw new Error('unreadable head'); }],
  ['assessment from another run', x => x.assessmentRunId = 'run-0'],
  ['assessment at another head', x => x.head = 'c'.repeat(40)],
  ['unknown diff cannot exempt MP items', x => delete x.diffPaths],
];
it.each(mutations)('%s refuses the seat', (_name, mutate) => {
  const x = input('security'); mutate(x);
  const result = assessSeat({ ...x, mode: 'enforce' });
  expect(result.gateOutcome).toBe('not-pass');
  expect(result.problems.length).toBeGreaterThan(0);
});
it('wrong rubric digest derives stale', () => {
  const x = input('security'); x.assessment.predicate.rubric.digest.sha256 = '0'.repeat(64);
  expect(assessSeat(x)).toMatchObject({ derived: 'unknown', reason: 'stale', gateOutcome: 'not-pass' });
});
it('unfilled template appliesTo 40 zeros derives stale', () => {
  const x = input('correctness'); x.rubric.appliesTo.gitCommit = '0'.repeat(40);
  x.assessment.predicate.rubric.digest = digestOf(x.rubric); x.expectedRubric = x.rubric;
  expect(assessSeat(x)).toMatchObject({ derived: 'unknown', reason: 'stale', gateOutcome: 'not-pass' });
});
it('correctness rubric text differing from the merge-base card is stale', () => {
  const x = input('correctness'); x.rubric.items[0].text = 'Seat authored its own easier criterion';
  x.assessment.predicate.rubric.digest = digestOf(x.rubric);
  expect(assessSeat(x)).toMatchObject({ reason: 'stale', gateOutcome: 'not-pass' });
});
it('no pinned acceptance refuses correctness', () => {
  expect(assessSeat({ ...input('correctness'), rubric: null, expectedRubric: null })).toMatchObject({ gateOutcome: 'not-pass' });
});
it('person vs model labels give identical derivation; no provider field is read', () => {
  const person = input('security'); const model = input('security');
  person.assessment.predicate.seat.evaluator = 'https://example.org/person';
  model.assessment.predicate.seat.evaluator = 'https://example.org/model';
  Object.defineProperty(person, 'provider', { get() { throw new Error('provider read'); } });
  expect(evaluateSeat(person)).toEqual(evaluateSeat(model));
});
it('assessment posted as a PR comment is ignored', () => {
  expect(assessSeat({ ...input('security'), assessment: null, comments: [data('security').assessment] }).gateOutcome).toBe('not-pass');
});
it('runner answers are wrapped and every citation is re-read at the exact head', () => {
  const x = input('security'); const read = vi.fn(x.readFileAtHead);
  const answers = { items: clone(x.assessment.predicate.items) };
  for (const a of answers.items) for (const e of a.evidence) delete e.revisionId;
  expect(assessSeat({ ...x, assessment: answers, readFileAtHead: read }).gateOutcome).toBe('pass');
  expect(read.mock.calls.length).toBeGreaterThan(0);
  expect(read.mock.calls.every(([h]) => h === head)).toBe(true);
});
it('unreadable policy and mode in enforce both refuse with a problem', () => {
  for (const bad of ['rubric-policy/company.json', 'rubric-mode.json']) {
    const read = path => {
      if (path.endsWith(bad)) throw new Error(`unreadable ${bad}`);
      if (path.endsWith('rubric-mode.json')) return JSON.stringify({ mode: 'enforce', shadowStartedAt: '2026-11-22T09:00:00-05:00', maxDays: 7 });
      return JSON.stringify(path.endsWith('security.rubric.json') ? data('security').rubric : data('security').policy);
    };
    const settings = readSeatSettings({ settingsPath: 'settings-checkout', read });
    expect(settings.problems.join(' ')).toContain('unreadable');
    expect(assessSeat({ ...input('security'), settings }).gateOutcome).toBe('not-pass');
  }
});
it('malformed mode or excessive shadow duration refuses, naming operator action', () => {
  for (const mode of [{ mode: 'other' }, { mode: 'shadow', maxDays: 8, shadowStartedAt: '2026-11-22' }]) {
    const result = readSeatSettings({ settingsPath: 'settings', read: p => JSON.stringify(p.endsWith('rubric-mode.json') ? mode : data('security').policy) });
    expect(result.problems.join(' ')).toMatch(/repair|decide/i);
    expect(assessSeat({ ...input('security'), settings: result }).gateOutcome).toBe('not-pass');
  }
});
it('shadow never changes panel output and writes one row per mandatory lens with run binding', () => {
  const rows = [];
  const x = { ...input('security'), pr: 7236, liveVerdict: 'accept', mode: 'shadow',
    shadowStartedAt: '2026-11-22T09:00:00-05:00', maxDays: 7, at: '2026-11-23T09:00:00-05:00',
    appendRow: row => rows.push(row) };
  const result = assessReviewSeats({ ...x, assessments: {}, rubrics: { security: x.rubric }, expectedRubric: null });
  expect(result.seatGates).toBeUndefined();
  expect(JSON.stringify(derivePanelVerdict({ ...panel, seatGates: result.seatGates }))).toBe(JSON.stringify(derivePanelVerdict(panel)));
  expect(rows).toHaveLength(2);
  for (const row of rows) expect(row).toMatchObject({ pr: 7236, head, runId: 'run-1', liveVerdict: 'accept', gateOutcome: 'not-pass' });
  expect(rows.every(row => row.problems.length > 0)).toBe(true);
});
it('shadow expires at maxDays without silently enforcing', () => {
  const rows = [];
  const result = assessReviewSeats({ ...input('security'), mode: 'shadow', assessments: {}, rubrics: {},
    shadowStartedAt: '2026-11-22T09:00:00-05:00', maxDays: 7, at: '2026-11-29T09:00:00-05:00', appendRow: row => rows.push(row) });
  expect(result.seatGates).toBeUndefined();
  expect(rows.every(row => row.expired === true && row.problems.some(p => p.includes('decide CKLST-B enforce')))).toBe(true);
});
it('shadow append failure is not-pass and surfaced, never a swallowed catch', () => {
  const r = assessSeat({ ...input('security'), mode: 'shadow', appendRow: () => { throw new Error('disk full'); } });
  expect(r).toMatchObject({ gateOutcome: 'not-pass' });
  expect(r.problems.join(' ')).toContain('disk full');
});
it('missing enforced gate reduces accept and gives a blank accept note without mutating findings', () => {
  const notes = []; const findings = [];
  expect(derivePanelVerdict({ ...panel, findings, seatGates: {}, seatGateNotes: notes })).toBe('changes');
  expect(notes.join(' ')).toContain('blank accept: answer');
  expect(findings).toEqual([]);
});
it('existing gates retain priority and advisory seats do not block', () => {
  expect(derivePanelVerdict({ ...panel, humanRequired: true, seatGates: {} })).toBe('needs-human');
  expect(derivePanelVerdict({ ...panel, seatGates: { security: 'pass', correctness: 'pass', simplicity: 'not-pass' } })).toBe('accept');
  expect(derivePanelVerdict(panel)).toBe('accept');
});
it('gate-deciding files and their invariant tests are registered at the policy tier', () => {
  for (const file of ['seat-assessment.mjs', 'seat-ac-rubric.mjs', 'seat-assessment.test.mjs', 'seat-ac-rubric.test.mjs'])
    expect(TRUST_CHAIN.find(x => x.file === file)).toMatchObject({ tier: 'policy', leash: file.includes('.test.') ? 'spec' : 'code' });
});
it('module imports no gh or network writer', () => {
  const source = readFileSync(new URL('../seat-assessment.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1]);
  expect(imports.every(p => ['node:crypto', 'node:fs', 'node:path', 'node:child_process', './lane-git-hardening.mjs', './seat-ac-rubric.mjs', './gate-config.mjs', './merge-queue-affected.mjs', 'ajv', 'ajv-formats'].includes(p))).toBe(true);
  expect(source).not.toMatch(/\b(?:fetch|https?|gh)\s*\(/);
});
it('git show is bounded, hardened and uses argv; rejects hostile paths before execution', () => {
  const exec = vi.fn(() => 'line');
  expect(readHeadFile(head, 'src/x.mjs', { cwd: '.', exec, env: { PATH: process.env.PATH, GIT_DIR: 'decoy', GIT_WORK_TREE: 'decoy' } })).toBe('line');
  const [bin, args, options] = exec.mock.calls[0];
  expect(bin).toBe('git'); expect(args).toContain(`${head}:src/x.mjs`);
  expect(options.env.GIT_DIR).toBeUndefined(); expect(options.env.GIT_WORK_TREE).toBeUndefined();
  expect(options.env.GIT_NO_REPLACE_OBJECTS).toBe('1'); expect(options.maxBuffer).toBeGreaterThan(0); expect(options.timeout).toBeGreaterThan(0);
  expect(() => readHeadFile(head, '../escape', { exec })).toThrow();
  expect(exec).toHaveBeenCalledTimes(1);
});
it('real git show reads immutable head content with hostile inherited git location removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-head-'));
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, TMPDIR: process.env.TMPDIR } }).trim();
  try {
    git(['init', '-q']); writeFileSync(join(dir, 'proof.txt'), 'pinned\n'); git(['add', 'proof.txt']);
    git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.org', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    const pinned = git(['rev-parse', 'HEAD']); writeFileSync(join(dir, 'proof.txt'), 'changed\n');
    expect(readHeadFile(pinned, 'proof.txt', { cwd: dir, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, GIT_DIR: 'invalid', GIT_WORK_TREE: 'invalid' } })).toBe('pinned\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('security and correctness prompts carry fenced rubric items and optional assessment schema', () => {
  const validate = addFormats(new Ajv2020({ strict: false })).compile(REVIEW_SEAT_RESPONSE_SCHEMA);
  expect(validate({ findings: [] })).toBe(true);
  expect(validate({ findings: [], assessment: { items: data('security').assessment.predicate.items } })).toBe(true);
  expect(validate({ findings: [], assessment: { items: [{ itemId: 'SB1', outcome: 'pass' }] } })).toBe(false);
  for (const lens of ['security', 'correctness']) {
    const prompt = buildPanelMandate({ lens, rubric: data(lens).rubric });
    expect(prompt).toContain('assessment.items'); expect(prompt).toContain(JSON.stringify(data(lens).rubric.items));
    expect(prompt).toContain('<rubric>');
  }
});

// Resolve the frozen release's merge patches and RFC6901 pointer mutations, as its own validator does.
const merge = (t, p) => {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return clone(p);
  const out = t && !Array.isArray(t) && typeof t === 'object' ? clone(t) : {};
  for (const [k, v] of Object.entries(p)) { if (v === null) delete out[k]; else out[k] = merge(out[k], v); }
  return out;
};
const vf = json('vectors/vectors.json');
function resolve(x) {
  if (typeof x === 'string' && x.startsWith('file:')) return json(`vectors/${x.slice(5)}`);
  if (Array.isArray(x)) return x.map(resolve);
  if (x && typeof x === 'object' && x.$base) {
    const o = merge(resolve(vf.bases[x.$base]), resolve(x.patch ?? {}));
    for (const [ptr, val] of Object.entries(x.set ?? {})) {
      const keys = ptr.split('/').slice(1).map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
      let cur = o; for (const k of keys.slice(0, -1)) cur = cur[k];
      const last = keys.at(-1);
      if (val === null) { if (Array.isArray(cur)) cur.splice(Number(last), 1); else delete cur[last]; }
      else if (Array.isArray(cur) && last === '-') cur.push(resolve(val)); else cur[last] = resolve(val);
    }
    return o;
  }
  return x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k,v]) => [k,resolve(v)])) : x;
}
describe('pinned core/verdict v0.1.2 parity', () => {
  it('pins the exact source digest and copied rule bodies', () => {
    const source = readFileSync(new URL('rules-v0.1.2.mjs', root), 'utf8');
    expect(createHash('sha256').update(source).digest('hex')).toBe(RULES_SHA256);
    const runtime = readFileSync(new URL('../seat-assessment.mjs', import.meta.url), 'utf8');
    expect(runtime).toContain(source.slice(source.indexOf('export const ASSESSMENT_T'), source.indexOf('export function makeRules')));
  });
  const ajv = addFormats(new Ajv2020({ strict: false }));
  for (const name of ['evidence-v0.1', 'verdict-v0.1', 'verdict-v0.1.1', 'verdict-v0.1.2']) ajv.addSchema(json(`${name}.schema.json`));
  it('compact runner answers become a schema-valid core/assessment Statement', () => {
    const x = input('security');
    const statement = wrapSeatAnswers({ ...x, answers: { items: x.assessment.predicate.items }, at: '2026-11-22T14:00:00Z' });
    expect(ajv.getSchema('https://everstandards.dev/core/0.1.2/verdict.schema.json#/$defs/assessment')(statement)).toBe(true);
  });
  const rules = makeRules({ ajv });
  for (const v of vf.vectors.filter(v => v.kind === 'rule' && !v.disputed)) {
    it(`${v.id}: ${v.note ?? v.target}`, () => {
      expect(rules[v.target.slice(5)](resolve(v.input)).length === 0).toBe(v.expect === 'valid');
    });
  }
  it('legacy no-rubric seat gate retains v0.1.1 semantics', () => {
    const verdict = json('live/7236-security/verdict.json');
    expect(seatGate({ seat: null, verdict, validVerdict: () => true }).outcome).toBe('pass');
    expect(deriveSeat({ seat: data('security').policy.seats[0], rubric: data('security').rubric, assessment: null }).reason).toBe('missing');
  });
});

it('oversized seat input refuses with an operator-visible fallback', () => {
  const x = input('security'); x.assessment.predicate.items[0].evidence[0].location.snippet = 'x'.repeat(4 * 1024 * 1024);
  expect(assessSeat(x)).toMatchObject({ gateOutcome: 'not-pass' });
  expect(assessSeat(x).problems.join(' ')).toContain('operator must review');
});
it('oversized citation and excessive line range refuse with a fallback', () => {
  const x = input('security'); x.readFileAtHead = () => 'x'.repeat(4 * 1024 * 1024 + 1);
  expect(assessSeat(x).problems.join(' ')).toContain('operator must review');
  const y = input('security'); y.assessment.predicate.items[0].evidence[0].location.endLine = 10002;
  y.assessment.predicate.items[0].evidence[0].location.startLine = 1;
  expect(assessSeat(y).problems.join(' ')).toContain('operator must review');
});
it('enforce orchestration with unreadable mode or pinned acceptance never omits failed gates', () => {
  const result = assessReviewSeats({ ...input('security'), mode: 'enforce', settings: { problems: ['mode unreadable'] }, assessments: {} });
  expect(result.seatGates).toEqual({ security: 'not-pass', correctness: 'not-pass' });
  expect(derivePanelVerdict({ ...panel, seatGates: result.seatGates })).toBe('changes');
  const badCard = assessReviewSeats({ ...input('security'), mode: 'enforce', expectedRubric: undefined,
    assessments: {}, mergeBase: 'b'.repeat(40), cardPath: 'backlog/card.md', readFileAtRevision: () => { throw new Error('card unreadable'); } });
  expect(badCard.seats.correctness.problems.join(' ')).toContain('card unreadable');
  expect(badCard.seatGates.correctness).toBe('not-pass');
});
it('shadow settings failures appear in the emitted row', () => {
  const rows = [];
  const result = assessSeat({ ...input('security'), settings: { mode: 'shadow', problems: ['policy unreadable'] }, appendRow: row => rows.push(row) });
  expect(result.gateOutcome).toBe('not-pass'); expect(rows[0].problems).toContain('policy unreadable');
});
it('shadow JSONL append serializes the required fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-row-'));
  try {
    const path = join(dir, 'shadow.jsonl');
    assessSeat({ ...input('security'), mode: 'shadow', pr: 7236, liveVerdict: 'accept',
      at: '2026-11-22T14:00:00Z', shadowPath: path });
    const rows = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(['pr','head','lens','derived','reason','problems','gateOutcome','liveVerdict','at','runId'].sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


it('compact pass with an incomplete verified-test core evidence reference is not-pass', () => {
  const x = input('security');
  const read = vi.fn(x.readFileAtHead);
  const assessment = { items: x.rubric.items.map(item => ({ itemId: item.id, outcome: 'pass',
    evidence: [{ kind: 'verified-test', ref: { uri: 'https://example.org/result', digest: { sha256: 'x' } } }] })) };
  const result = assessSeat({ ...x, assessment, readFileAtHead: read, mode: 'enforce' });
  expect(result.gateOutcome).toBe('not-pass');
  expect(result.problems.length).toBeGreaterThan(0);
  expect(read).not.toHaveBeenCalled();
});


const testResultRef = () => ({ kind: 'test-result', uri: 'https://example.org/result',
  digest: { sha256: 'a'.repeat(64) }, provenanceTier: 'replayed' });
function verifiedAnswers(x, ref) {
  return { items: x.rubric.items.map(item => ({ itemId: item.id, outcome: 'pass',
    evidence: [{ kind: 'verified-test', ref: clone(ref) }] })) };
}

describe('Core evidence references stay distinct from rubric references', () => {
  const pinned = json('evidence-v0.1.schema.json');
  const ajv = addFormats(new Ajv2020({ strict: false }));
  ajv.addSchema(pinned);
  const validRef = ajv.getSchema(`${pinned.$id}#/$defs/evidenceRef`);
  const validResponse = ajv.compile(REVIEW_SEAT_RESPONSE_SCHEMA);
  for (const name of ['verdict-v0.1', 'verdict-v0.1.1', 'verdict-v0.1.2']) ajv.addSchema(json(`${name}.schema.json`));
  const validStatement = ajv.getSchema('https://everstandards.dev/core/0.1.2/verdict.schema.json#/$defs/assessment');

  it('embedded evidence reference schema matches the pinned Core contract', () => {
    const expected = clone(pinned.$defs.evidenceRef);
    expected.properties.digest = pinned.$defs.digestSet;
    expected.properties.provenanceTier = pinned.$defs.provenanceTier;
    expected.properties.statement = pinned.$defs.digestSet;
    expect(SEAT_EVIDENCE_REF_SCHEMA).toEqual(expected);
  });

  const badRefs = [
    ['missing kind', r => delete r.kind],
    ['empty kind', r => r.kind = ''],
    ['missing provenanceTier', r => delete r.provenanceTier],
    ['unknown provenanceTier', r => r.provenanceTier = 'verified'],
    ['missing digest', r => delete r.digest],
    ['empty digest', r => r.digest = {}],
    ['short sha256', r => r.digest.sha256 = 'x'],
    ['non-hex sha256', r => r.digest.sha256 = 'z'.repeat(64)],
    ['short extension digest', r => r.digest = { custom: 'ab' }],
    ['unknown reference field', r => r.trustMe = true],
    ['invalid statement digest', r => r.statement = { sha256: 'x' }],
    ['malformed URI', r => r.uri = 'http://[invalid'],
  ];
  it.each(badRefs)('%s refuses compact and full Statements before any citation read', (_name, mutate) => {
    const x = input('security'), ref = testResultRef(); mutate(ref);
    expect(validRef(ref)).toBe(false);
    const answers = verifiedAnswers(x, ref);
    const full = clone(x.assessment); full.predicate.items = answers.items;
    expect(validStatement(full)).toBe(false);
    expect(validResponse({ findings: [], assessment: answers })).toBe(false);
    expect(() => wrapSeatAnswers({ ...x, answers, at: '2026-11-22T14:00:00Z' })).toThrow('invalid runner assessment');
    for (const assessment of [answers, full]) {
      const read = vi.fn(x.readFileAtHead);
      const result = assessSeat({ ...x, assessment, mode: 'enforce', readFileAtHead: read });
      expect(result.gateOutcome).toBe('not-pass');
      expect(result.problems.length).toBeGreaterThan(0);
      expect(read).not.toHaveBeenCalled();
    }
  });

  it.each(['absolute URI', 'relative URI', 'no URI'])('schema-valid evidence with %s remains accepted', form => {
    const x = input('security'), ref = testResultRef();
    if (form === 'relative URI') ref.uri = 'results/test-result.json';
    if (form === 'no URI') delete ref.uri;
    expect(validRef(ref)).toBe(true);
    const answers = verifiedAnswers(x, ref);
    expect(validResponse({ findings: [], assessment: answers })).toBe(true);
    const statement = wrapSeatAnswers({ ...x, answers, at: '2026-11-22T14:00:00Z' });
    expect(validStatement(statement)).toBe(true);
    expect(assessSeat({ ...x, assessment: answers }).gateOutcome).toBe('pass');
    expect(assessSeat({ ...x, assessment: statement }).gateOutcome).toBe('pass');
  });
});


it('same-head prior full Statement with omitted assessmentRunId refuses replay', () => {
  const previous = input('security');
  expect(assessSeat({ ...previous, assessmentRunId: 'run-1', mode: 'enforce' }).gateOutcome).toBe('pass');
  const read = vi.fn(previous.readFileAtHead);
  const replay = { ...previous, runId: 'run-2', assessment: clone(previous.assessment), readFileAtHead: read, mode: 'enforce' };
  delete replay.assessmentRunId;
  const result = assessSeat(replay);
  expect(result).toMatchObject({ gateOutcome: 'not-pass', reason: 'stale' });
  expect(result.problems.join(' ')).toContain('run binding');
  expect(read).not.toHaveBeenCalled();
});


it.each([undefined, null, '', '   ', 1, 'run-0'])('missing, invalid or stale assessment run binding %s refuses compact answers', assessmentRunId => {
  const x = input('security'), read = vi.fn(x.readFileAtHead);
  const result = assessSeat({ ...x, assessmentRunId, assessment: { items: x.assessment.predicate.items }, readFileAtHead: read });
  expect(result).toMatchObject({ gateOutcome: 'not-pass', reason: 'stale' });
  expect(result.problems.join(' ')).toContain('run binding');
  expect(read).not.toHaveBeenCalled();
});
it.each([undefined, null, '', '   ', 1])('invalid current run %s cannot self-confirm assessment provenance', runId => {
  expect(assessSeat({ ...input('security'), runId, assessmentRunId: runId })).toMatchObject({ gateOutcome: 'not-pass', reason: 'stale' });
});
it('enforce orchestration requires independently retained provenance for each lens', () => {
  const options = { ...input('security'), mode: 'enforce', expectedRubric: data('correctness').rubric,
    rubrics: { security: data('security').rubric },
    assessments: { security: data('security').assessment, correctness: data('correctness').assessment },
    assessmentRunIds: { security: 'run-1', correctness: 'run-1' } };
  const valid = assessReviewSeats(options);
  expect(valid.seatGates).toEqual({ security: 'pass', correctness: 'pass' });
  expect(derivePanelVerdict({ ...panel, seatGates: valid.seatGates })).toBe('accept');
  for (const assessmentRunIds of [{}, { security: 'run-1' }, { security: 'run-1', correctness: 'run-0' }]) {
    const result = assessReviewSeats({ ...options, assessmentRunIds });
    expect(result.seatGates.correctness).toBe('not-pass');
    expect(result.seats.correctness.problems.join(' ')).toContain('run binding');
    expect(derivePanelVerdict({ ...panel, seatGates: result.seatGates })).toBe('changes');
  }
  // A common caller runId or assessmentRunId cannot substitute for each seat's retained provenance.
  const absent = assessReviewSeats({ ...options, assessmentRunIds: undefined });
  expect(absent.seatGates).toEqual({ security: 'not-pass', correctness: 'not-pass' });
});
it('shadow records an omitted binding as not-pass without supplying panel gates', () => {
  const rows = [];
  const x = input('security');
  const result = assessReviewSeats({ ...x, mode: 'shadow', assessments: { security: x.assessment },
    rubrics: { security: x.rubric }, appendRow: row => rows.push(row) });
  expect(result.seatGates).toBeUndefined();
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.gateOutcome === 'not-pass' && row.problems.some(p => p.includes('run binding')))).toBe(true);
  expect(derivePanelVerdict({ ...panel, seatGates: result.seatGates })).toBe('accept');
});


const naRef = check => ({ uri: check.uri, digest: clone(check.digest), result: check.result });
function conditionalInput() {
  const x = input('security'), check = mergePathNaCheck({ diffPaths: [] });
  x.rubric = json('security.rubric.json'); x.policy = json('policy.company.json');
  for (const item of x.rubric.items.filter(item => /^MP\d+$/.test(item.id)))
    item.naWhen = { uri: check.uri, digest: check.digest };
  x.policy.seats[0].rubric = { uri: x.rubric.id, digest: digestOf(x.rubric) };
  x.assessment.predicate.rubric = clone(x.policy.seats[0].rubric);
  x.assessment.predicate.policy = { uri: x.policy.id, digest: digestOf(x.policy) };
  for (const item of x.assessment.predicate.items.filter(item => item.outcome === 'n/a')) item.naCheck = naRef(check);
  return x;
}
it('merge-path naWhen uses the shared merge gate lists, including relocated trust-chain files', () => {
  const paths = [...TRUST_CHAIN.flatMap(item => item.homes ?? []), '.githooks/pre-push', 'scripts/ci/check.mjs',
    'vitest.config.ts', 'docs/article.md', 'scripts/lib/unrelated-helper.mjs', 'relocated/review-core.mjs'];
  for (const path of paths) {
    expect(mergePathNaCheck({ diffPaths: [path] }).result).toBe(isTrustChainPath(path) || isGateFile(path) ? 'fail' : 'pass');
  }
  const check = mergePathNaCheck({ diffPaths: [] });
  expect(check.digest).toEqual(digestOf(MERGE_PATH_CHECK_DEFINITION));
  expect(check.uri).toBe('https://github.com/plateauapp/plateau-settings/blob/main/review/checks/diff-touches-no-merge-path');
});
it('merge-path naWhen computes and records pass for compact n/a on a non-merge diff', () => {
  const x = conditionalInput(), check = mergePathNaCheck({ diffPaths: ['docs/article.md'] });
  const answers = { items: clone(x.assessment.predicate.items) };
  for (const item of answers.items) delete item.naCheck;
  const statement = wrapSeatAnswers({ ...x, answers, at: '2026-11-22T14:00:00Z', naCheck: check });
  expect(statement.predicate.items.filter(item => item.outcome === 'n/a').every(item => JSON.stringify(item.naCheck) === JSON.stringify(naRef(check)))).toBe(true);
  expect(assessSeat({ ...x, assessment: answers, diffPaths: ['docs/article.md'] }).gateOutcome).toBe('pass');
});
it('merge-path naWhen recomputes the actual base...head diff instead of trusting supplied clean paths', () => {
  const x = conditionalInput(), readDiff = vi.fn(() => ['scripts/lib/gate-config.mjs']);
  const result = assessSeat({ ...x, base: 'b'.repeat(40), diffPaths: [], readDiff });
  expect(readDiff).toHaveBeenCalledWith('b'.repeat(40), head);
  expect(result.gateOutcome).toBe('not-pass');
  expect(result.problems.join(' ')).toContain('merge-path');
});
it('merge-path naWhen refuses missing, oversized and unreadable diff evidence with a fallback', () => {
  for (const diffPaths of [undefined, Array(10001).fill('docs/a.md')]) {
    const result = mergePathNaCheck({ diffPaths });
    expect(result.result).toBe('fail'); expect(result.problems.join(' ')).toContain('operator');
  }
  const invalidRead = vi.fn(() => []);
  expect(mergePathNaCheck({ base: 'main', head, readDiff: invalidRead }).result).toBe('fail');
  expect(invalidRead).not.toHaveBeenCalled();
  const x = conditionalInput();
  expect(assessSeat({ ...x, base: 'b'.repeat(40), readDiff: () => { throw new Error('diff unreadable'); } }).gateOutcome).toBe('not-pass');
});
it('merge-path naWhen refuses the supplied placeholder digest until the rubric is repinned', () => {
  const x = conditionalInput(); x.rubric = json('security.rubric.json'); x.policy = json('policy.company.json');
  x.assessment.predicate.rubric = { uri: x.rubric.id, digest: digestOf(x.rubric) };
  x.assessment.predicate.policy = { uri: x.policy.id, digest: digestOf(x.policy) };
  expect(assessSeat(x)).toMatchObject({ gateOutcome: 'not-pass', reason: 'stale' });
});
it.each(['missing', 'failed', 'wrong digest'])('CORE-VRD-054 refuses a full conditional n/a with %s naCheck', variant => {
  const x = conditionalInput(), answer = x.assessment.predicate.items.find(item => item.outcome === 'n/a');
  if (variant === 'missing') delete answer.naCheck;
  if (variant === 'failed') answer.naCheck.result = 'fail';
  if (variant === 'wrong digest') answer.naCheck.digest.sha256 = '0'.repeat(64);
  const result = assessSeat(x);
  expect(result.gateOutcome).toBe('not-pass'); expect(result.problems.join(' ')).toContain('CORE-VRD-054');
});
it.each(['fail', 'n/a'])('CORE-VRD-055 requires file, line and head for %s', outcome => {
  const x = conditionalInput(), answer = x.assessment.predicate.items.find(item => item.outcome === 'n/a');
  answer.outcome = outcome; answer.reason = 'Criterion does not hold'; answer.evidence = [];
  const result = assessSeat(x);
  expect(result.gateOutcome).toBe('not-pass'); expect(result.problems.join(' ')).toContain('CORE-VRD-055');
});
it('base...head diff reader is bounded, hardened and includes both sides of renames', () => {
  const exec = vi.fn(() => 'docs/article.md\0scripts/lib/gate-config.mjs\0');
  expect(readDiffPaths('b'.repeat(40), head, { exec, env: { GIT_DIR: 'decoy', GIT_WORK_TREE: 'decoy' } })).toEqual(['docs/article.md', 'scripts/lib/gate-config.mjs']);
  const [, args, options] = exec.mock.calls[0];
  expect(args).toContain(`${'b'.repeat(40)}...${head}`); expect(args).toContain('--no-renames');
  expect(options.env.GIT_DIR).toBeUndefined(); expect(options.env.GIT_WORK_TREE).toBeUndefined();
  expect(options.maxBuffer).toBeGreaterThan(0); expect(options.timeout).toBeGreaterThan(0);
  expect(() => readDiffPaths('main', head, { exec })).toThrow();
});


it('real Git base...head check ignores base-only changes and dirty files and refuses a moved merge-path file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-diff-'));
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: dir };
  const git = args => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.org',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', env }).trim();
  try {
    mkdirSync(join(dir, 'scripts/lib'), { recursive: true }); mkdirSync(join(dir, 'docs'));
    git(['init', '-q']); writeFileSync(join(dir, 'scripts/lib/gate-config.mjs'), '// initial gate\n');
    git(['add', '.']); git(['commit', '-qm', 'initial']); const common = git(['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'scripts/lib/review-core.mjs'), '// base-only change\n');
    git(['add', '.']); git(['commit', '-qm', 'base']); const base = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', '--detach', common]);
    writeFileSync(join(dir, 'docs/article.md'), 'safe change\n');
    git(['add', 'docs/article.md']); git(['commit', '-qm', 'head']); const pinned = git(['rev-parse', 'HEAD']);
    mkdirSync(join(dir, '.githooks')); writeFileSync(join(dir, '.githooks/pre-push'), 'uncommitted\n');
    expect(readDiffPaths(base, pinned, { cwd: dir, env })).toEqual(['docs/article.md']);
    expect(mergePathNaCheck({ base, head: pinned, cwd: dir, env }).result).toBe('pass');
    git(['mv', 'scripts/lib/gate-config.mjs', 'docs/moved.mjs']); git(['commit', '-qm', 'move gate']);
    const movedHead = git(['rev-parse', 'HEAD']);
    const check = mergePathNaCheck({ base, head: movedHead, cwd: dir, env });
    expect(check.result).toBe('fail'); expect(check.diffPaths).toContain('scripts/lib/gate-config.mjs');
    expect(check.diffPaths).toContain('docs/moved.mjs');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('a forged passing naCheck cannot override the actual merge-path diff', () => {
  const x = conditionalInput();
  expect(assessSeat({ ...x, diffPaths: ['scripts/lib/gate-config.mjs'] }).gateOutcome).toBe('not-pass');
});
it('a full conditional assessment passes only with the matching successful check and citations', () => {
  expect(assessSeat({ ...conditionalInput(), diffPaths: ['docs/article.md'] }).gateOutcome).toBe('pass');
});
it('diff reader bounds name an operator fallback for oversized command output', () => {
  for (const output of ['a\0'.repeat(10001), 'a'.repeat(4 * 1024 * 1024 + 1)])
    expect(() => readDiffPaths('b'.repeat(40), head, { exec: () => output })).toThrow('operator must review the full diff');
});


function loadFrozenPolicyChain(repo = json('vectors/policy.repo.json'), company = json('vectors/policy.company.json')) {
  const files = new Map([
    ['rubric-mode.json', { mode: 'enforce', shadowStartedAt: '2026-11-22T09:00:00-05:00', maxDays: 7 }],
    ['rubric-policy/company.json', company], ['rubric-policy/repo.json', repo],
    ['rubrics/security.rubric.json', json('vectors/merge-path.rubric.json')],
  ].map(([path, data]) => [join('settings-checkout', 'review', path), data]));
  const log = vi.fn();
  const settings = readSeatSettings({ settingsPath: 'settings-checkout',
    policyPaths: ['rubric-policy/company.json', 'rubric-policy/repo.json'], log,
    read: path => {
      if (!files.has(path)) throw new Error(`unexpected policy read: ${path}`);
      return JSON.stringify(files.get(path));
    } });
  return { settings, company, repo, log };
}
it('readSeatSettings accepts the frozen company to repo chain with a Core parent reference', () => {
  const { settings, company, repo, log } = loadFrozenPolicyChain();
  const ajv = addFormats(new Ajv2020({ strict: false }));
  for (const name of ['evidence-v0.1', 'verdict-v0.1', 'verdict-v0.1.1', 'verdict-v0.1.2']) ajv.addSchema(json(`${name}.schema.json`));
  const valid = ajv.getSchema('https://everstandards.dev/core/0.1.2/verdict.schema.json#/$defs/rubricPolicy');
  expect(valid(company)).toBe(true); expect(valid(repo)).toBe(true);
  expect(repo.parent).toEqual({ uri: company.id, digest: digestOf(company) });
  expect(settings.problems).toEqual([]);
  expect(settings.policy).toMatchObject({ id: repo.id, level: 'repo', parent: repo.parent });
  expect(settings.policy.seats.find(seat => seat.lens === 'security')).toEqual(repo.seats[0]);
  expect(settings.policy.seats.find(seat => seat.lens === 'correctness')).toEqual(company.seats[1]);
  expect(settings.sources['rubric-policy/repo.json']).toBe(join('settings-checkout', 'review', 'rubric-policy/repo.json'));
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ mode: 'enforce', problems: [] }));
});
it.each([null, 'company', { uri: 'https://example.org/company' }, { digest: { sha256: 'a'.repeat(64) } }])(
  'readSeatSettings refuses malformed parent reference %j', parent => {
    const repo = json('vectors/policy.repo.json'); repo.parent = parent;
    const { settings } = loadFrozenPolicyChain(repo);
    expect(settings.problems.join(' ')).toContain('invalid rubric policy');
    expect(assessSeat({ ...input('security'), settings }).gateOutcome).toBe('not-pass');
  },
);


it('a new child per-item evidence override below the inherited global minimum requires confirmation', () => {
  const repo = json('vectors/policy.repo.json');
  repo.seats[0].evidence.perItem = { MP1: 'assertion' };
  const { settings } = loadFrozenPolicyChain(repo);
  expect(settings.problems.join(' ')).toContain('repo loosens security.evidence.perItem.MP1 without confirmation from company');
  expect(assessSeat({ ...input('security'), settings }).gateOutcome).toBe('not-pass');
});


function evidencePolicies(parentEvidence, childEvidence) {
  const company = json('vectors/policy.company.json'), repo = json('vectors/policy.repo.json');
  company.seats[0].evidence = clone(parentEvidence); repo.seats[0].evidence = clone(childEvidence);
  repo.parent = { uri: company.id, digest: digestOf(company) };
  return { company, repo };
}
const evidenceMinimumCases = [
  ['new override weakens inherited global floor', { minKind: 'quoted-citation' }, { minKind: 'quoted-citation', perItem: { MP1: 'assertion' } }, true],
  ['changed override weakens parent override', { minKind: 'quoted-citation', perItem: { MP1: 'verified-test' } }, { minKind: 'quoted-citation', perItem: { MP1: 'assertion' } }, true],
  ['removed override falls back to weaker global floor', { minKind: 'quoted-citation', perItem: { MP1: 'verified-test' } }, { minKind: 'quoted-citation' }, true],
  ['new stronger override is tightening', { minKind: 'quoted-citation' }, { minKind: 'quoted-citation', perItem: { MP1: 'verified-test' } }, false],
  ['changed stronger override is tightening', { minKind: 'quoted-citation', perItem: { MP1: 'assertion' } }, { minKind: 'quoted-citation', perItem: { MP1: 'resolved-citation' } }, false],
  ['removed weak override tightens to global floor', { minKind: 'quoted-citation', perItem: { MP1: 'assertion' } }, { minKind: 'quoted-citation' }, false],
  ['equal override preserves effective floor', { minKind: 'quoted-citation', perItem: { MP1: 'resolved-citation' } }, { minKind: 'quoted-citation', perItem: { MP1: 'resolved-citation' } }, false],
  ['new unknown-kind override cannot satisfy global floor', { minKind: 'quoted-citation' }, { minKind: 'quoted-citation', perItem: { MP1: 'x-other-proof' } }, true],
];
it.each(evidenceMinimumCases)('effective per-item evidence minimum: %s', (_name, parent, child, needsConfirmation) => {
  const { company, repo } = evidencePolicies(parent, child);
  const { settings } = loadFrozenPolicyChain(repo, company);
  if (needsConfirmation) {
    const messages = settings.problems.join(' ');
    expect(messages).toContain('security.evidence.perItem.MP1 without confirmation from company');
    expect(messages.match(/security\.evidence\.perItem\.MP1/g)).toHaveLength(1);
    expect(assessSeat({ ...input('security'), settings }).gateOutcome).toBe('not-pass');
  } else expect(settings.problems).toEqual([]);
});
it('a new per-item downgrade is permitted only with confirmation bound to the exact child policy', () => {
  const { company, repo } = evidencePolicies({ minKind: 'quoted-citation' }, { minKind: 'quoted-citation', perItem: { MP1: 'assertion' } });
  repo.confirmations = [{ lens: 'security', setting: 'evidence.perItem.MP1', level: 'company',
    owner: 'https://example.org/company-owner', policyDigest: policyDigest(repo) }];
  expect(loadFrozenPolicyChain(repo, company).settings.problems).toEqual([]);
  repo.seats[0].evidence.perItem.MP1 = 'resolved-citation';
  expect(loadFrozenPolicyChain(repo, company).settings.problems.join(' ')).toContain('without confirmation');
});
it.each(['wrong setting', 'wrong level', 'no owner', 'wrong digest'])('new per-item downgrade rejects confirmation with %s', variant => {
  const { company, repo } = evidencePolicies({ minKind: 'quoted-citation' }, { minKind: 'quoted-citation', perItem: { MP1: 'assertion' } });
  const confirmation = { lens: 'security', setting: 'evidence.perItem.MP1', level: 'company',
    owner: 'https://example.org/company-owner', policyDigest: policyDigest(repo) };
  if (variant === 'wrong setting') confirmation.setting = 'evidence.minKind';
  if (variant === 'wrong level') confirmation.level = 'team';
  if (variant === 'no owner') delete confirmation.owner;
  if (variant === 'wrong digest') confirmation.policyDigest = { sha256: '0'.repeat(64) };
  repo.confirmations = [confirmation];
  expect(loadFrozenPolicyChain(repo, company).settings.problems.join(' ')).toContain('without confirmation');
});
it('a per-item downgrade requires confirmation from every ancestor configuring that lens', () => {
  const { company, repo } = evidencePolicies({ minKind: 'quoted-citation' }, { minKind: 'quoted-citation', perItem: { MP1: 'assertion' } });
  const team = clone(company); team.id = 'https://example.org/policies/team'; team.level = 'team';
  team.parent = { uri: company.id, digest: digestOf(company) };
  repo.parent = { uri: team.id, digest: digestOf(team) };
  const load = () => {
    const files = new Map([['rubric-mode.json', { mode: 'enforce', shadowStartedAt: '2026-11-22T09:00:00-05:00', maxDays: 7 }],
      ['rubrics/security.rubric.json', json('vectors/merge-path.rubric.json')],
      ...[company, team, repo].map(policy => [`rubric-policy/${policy.level}.json`, policy])]
      .map(([path, data]) => [join('settings-checkout', 'review', path), data]));
    return readSeatSettings({ settingsPath: 'settings-checkout', policyPaths: ['rubric-policy/company.json', 'rubric-policy/team.json', 'rubric-policy/repo.json'],
      read: path => JSON.stringify(files.get(path)) });
  };
  repo.confirmations = [{ lens: 'security', setting: 'evidence.perItem.MP1', level: 'company',
    owner: 'https://example.org/company-owner', policyDigest: policyDigest(repo) }];
  expect(load().problems.join(' ')).toContain('without confirmation from company, team');
  repo.confirmations.push({ ...repo.confirmations[0], level: 'team', owner: 'https://example.org/team-owner' });
  expect(load().problems).toEqual([]);
});
