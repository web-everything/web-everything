import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isKnownMachineBody, latestAcceptRecord } from '../accept-carry-forward.mjs';
import * as gate from '../red-team-gate.mjs';
import { parseVerdictCarriedMarker } from '../review-verdict-carried-marker.mjs';
import { isTrustedMarkerAuthor } from '../marker-authorship.mjs';
import { findCarriableVerdict } from '../rebase-verdict-carry.mjs';

const OLD = '1c4c86cbf17231dfaba189161ff36e6c8e8dde7d';
const trusted = { author: { login: 'web-everything[bot]' } };

// The shape review-extra-seats.mjs renders for an UNCONFIRMED finding that carries classification lines.
const advisory = (extra = '') => [
  `<!-- we:red-team-advisory pr=6549 rev=${OLD} -->`,
  "### Post-accept red team — 1 possible break(s), 0 confirmed by Claude's re-check",
  '',
  'Advisory only: this comment changes no label itself; the red-team gate (setting `redTeam.confirmedBreaks`) sends a confirmed broken break back to the fixer. '
    + `Head \`${OLD.slice(0, 12)}\` · red team codex/gpt-6.1-sol · re-check ok · recorded verdict \`accept\`.`,
  '',
  '1. [not confirmed] (edge-case, broken) `scripts/lib/x.mjs:192` — a summary',
  '   - Class: live-reproduced → fix-now (basis: executed the module)',
  '   - Also class: theoretical-race',
  ...(extra ? [extra] : []),
  '   - Scenario: a scenario',
  '   - Re-check: insufficient evidence',
  '   - Files read: scripts/lib/x.mjs',
  '',
  "A confirmed break is recorded as a miss for the accepting review and for the builder's model.",
].join('\n');

describe('red-team advisory with Class / Also class lines is a machine note, not a later hold', () => {
  it('treats the rendered Class and Also class sublines as non-blocking for a trusted author', () => {
    expect(isKnownMachineBody(advisory(), trusted)).toBe(true);
  });
  it('still refuses an untrusted author', () => {
    expect(isKnownMachineBody(advisory(), { author: { login: 'mallory' } })).toBe(false);
  });
  it('still refuses an unknown subline', () => {
    expect(isKnownMachineBody(advisory('   - Verdict: ship it'), trusted)).toBe(false);
  });
  it('still refuses a malformed Class line', () => {
    expect(isKnownMachineBody(advisory().replace('live-reproduced → fix-now', 'live-reproduced'), trusted)).toBe(false);
  });
  it('does not make the accept on that head read as superseded', () => {
    const accept = { author: { login: 'web-everything[bot]' }, createdAt: '2026-11-08T22:00:00Z',
      body: `✅ review — accepted\n<!-- reviewed-sha: ${OLD} -->` };
    const rec = latestAcceptRecord([accept, { ...trusted, createdAt: '2026-11-08T22:05:00Z', body: advisory() }]);
    expect(rec?.sha).toBe(OLD);
    expect(rec.laterVerdict).toBe(false);
  });
});

describe('review-verdict-carried envelope around a non-blocking advisory is a machine note', () => {
  const NEW = '3a35250ae6aadf6fe7dee8b2420c929e3482c00c';
  const PATCH = 'f24d967614721e68a1bb02a2560bff7f83b38cd6';
  const marker = (to = NEW) => `<!-- review-verdict-carried from=${OLD} to=${to} patch-id=${PATCH} -->`;
  const sentence = 'Review verdict carried across an identical contribution.';
  // The carry writer re-binds the advisory marker to the new head but keeps the original "Head" label.
  const carriedAdvisory = (rev = NEW) => advisory().replace(`rev=${OLD}`, `rev=${rev}`);
  const envelope = (inner, to = NEW) => `${marker(to)}\n${sentence}\n${inner}`;

  it('accepts marker + sentence + advisory bound to the carried-to head', () => {
    expect(isKnownMachineBody(envelope(carriedAdvisory()), trusted)).toBe(true);
  });
  it('accepts marker + sentence alone', () => {
    expect(isKnownMachineBody(`${marker()}\n${sentence}`, trusted)).toBe(true);
  });
  it('refuses an untrusted author', () => {
    expect(isKnownMachineBody(envelope(carriedAdvisory()), { author: { login: 'mallory' } })).toBe(false);
  });
  it('refuses when the advisory is bound to a head other than the carried-to head', () => {
    expect(isKnownMachineBody(envelope(carriedAdvisory(OLD)), trusted)).toBe(false);
  });
  it('refuses when the shown Head label is not the carried-from head', () => {
    expect(isKnownMachineBody(envelope(carriedAdvisory().replace(`Head \`${OLD.slice(0, 12)}\``, 'Head `aaaaaaaaaaaa`')), trusted)).toBe(false);
  });
  it('refuses an appended hold in the envelope', () => {
    expect(isKnownMachineBody(`${envelope(carriedAdvisory())}\n\n🔁 review — changes requested`, trusted)).toBe(false);
    expect(isKnownMachineBody(`${marker()}\n${sentence}\nplease do not merge`, trusted)).toBe(false);
  });
  it('refuses a blocking advisory inside the envelope', () => {
    const blocking = carriedAdvisory().replace('[not confirmed]', '[confirmed]').replace('0 confirmed', '1 confirmed');
    expect(isKnownMachineBody(envelope(blocking), trusted)).toBe(false);
  });
});


describe('gate-prefixed carried advisory after acceptance (PR 6584)', () => {
  const sha = 'a'.repeat(40);
  const body = (impact = 'degraded', rev = sha) => [
    `<!-- we:red-team-gate pr=6584 rev=${sha} outcome=card-queued result=${'d'.repeat(16)} -->`,
    `<!-- review-verdict-carried from=${OLD} to=${sha} patch-id=${'b'.repeat(40)} -->`,
    'Review verdict carried across an identical contribution.',
    `<!-- we:red-team-advisory pr=6584 rev=${rev} -->`,
    "### Post-accept red team \u2014 1 possible break(s), 1 confirmed by Claude's re-check",
    '',
    'Advisory only: this comment changes no label itself; the red-team gate (setting `redTeam.confirmedBreaks`) sends a confirmed broken break back to the fixer. '
      + `Head \`${OLD.slice(0, 12)}\` \u00b7 red team codex/gpt-6.1-sol \u00b7 re-check ok \u00b7 recorded verdict \`changes\`.`,
    '',
    `1. [**confirmed**] (edge-case, ${impact}) \`scripts/x.mjs:253\` \u2014 Unreachable later effects can block replay`,
    '   - Class: live-reproduced \u2192 fix-now (basis: probe)',
    '   - Also class: correctness-in-normal-use',
    '   - Scenario: a scenario',
    '   - Re-check: demonstrated break',
    '   - Files read: scripts/x.mjs',
    '',
    "A confirmed break is recorded as a miss for the accepting review and for the builder's model.",
  ].join('\n');
  const later = (text, author = trusted) => latestAcceptRecord([
    { ...trusted, body: `✅ review — accepted\n<!-- reviewed-sha: ${sha} -->` },
    { ...author, body: text },
  ]).laterVerdict;
  it('keeps acceptance for a confirmed degraded finding', () => expect(later(body())).toBe(false));
  it('holds for a confirmed broken finding', () => expect(later(body('broken'))).toBe(true));
  it('holds for appended prose', () => expect(later(body() + '\nPlease hold this change.')).toBe(true));
  it('holds for an untrusted author', () => expect(later(body(), { author: { login: 'mallory' } })).toBe(true));
  it('holds for a mismatched advisory sha', () => expect(later(body('degraded', OLD))).toBe(true));
});

// Synthetic thread evidence only: no checkout, process, clock or GitHub reads.
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40);
const chainPr = 6549;
const chainComment = body => ({ ...trusted, body, createdAt: '2026-11-01T00:00:00Z' });
const clean = (rev = A, label = A.slice(0, 12)) => [
  `<!-- we:red-team-advisory pr=${chainPr} rev=${rev} -->`,
  '### Post-accept red team — no break found', '',
  'Advisory only: this comment changes no label itself; the red-team gate (setting `redTeam.confirmedBreaks`) sends a confirmed broken break back to the fixer. '
    + `Head \`${label}\` · red team codex/test · re-check ok · recorded verdict \`accept\`.`, '',
  'The red team tried to break this change and reported nothing.',
].join('\n');
const hop = (from, to, adv = clean(to)) => chainComment([
  `<!-- review-verdict-carried from=${from} to=${to} patch-id=${'e'.repeat(40)} -->`,
  'Review verdict carried across an identical contribution.', adv,
].join('\n'));
const stamp = sha => chainComment(`📌 review — acceptance re-stamped\n<!-- reviewed-sha: ${sha} -->`);
const chain = () => [chainComment(`✅ review — accepted\n<!-- reviewed-sha: ${A} -->`),
  chainComment(clean()), stamp(B), hop(A, B), stamp(C), hop(B, C)];
const tail = text => text.replace(/\r\n/g, '\n').split('\n').slice(1).join('\n');
const resultId = gate.redTeamResultId(gate.parseRedTeamComment(clean()));
const gatePrefix = (sha, id = resultId, pr = chainPr) => gate.redTeamGateMarker(pr, sha, 'card-queued', id);
const gateRecord = (sha, id = resultId, pr = chainPr) => chainComment(`${gatePrefix(sha, id, pr)}\n**Red-team gate** (setting \`redTeam.confirmedBreaks\`, card x1b8hlo) on head \`${sha.slice(0, 12)}\`:\n- 1 finding(s) filed as a follow-up card (#1) — landing job test.`);
const gatedChain = (id = resultId) => {
  const cs = chain(); cs.splice(2, 0, gateRecord(A, id));
  for (const index of [4, 6]) cs[index].body = `${gatePrefix(index === 4 ? B : C, id)}\n${cs[index].body}`;
  return cs;
};
const withWindow = c => { const cs = chain(); cs.splice(4, 0, c); return cs; };
const rich = (rev, confirmed = false) => advisory().replaceAll(OLD, A).replace(`rev=${A}`, `rev=${rev}`)
  .replace('[not confirmed]', confirmed ? '[**confirmed**]' : '[not confirmed]')
  .replace('0 confirmed', confirmed ? '1 confirmed' : '0 confirmed');

// Previous D3, deliberately test-only: prefix-only links, unordered lookup, any
// matching origin, and no supersession/review window. Kept to prove the red cases.
function previousD3(cs) {
  const e = cs.at(-1), earlier = cs.slice(0, -1), marker = parseVerdictCarriedMarker(e.body);
  const label = /Head `([0-9a-f]{12})`/.exec(e.body)?.[1];
  if (!marker || !label || !isTrustedMarkerAuthor(e)) return false;
  const adv = e.body.slice(e.body.indexOf('<!-- we:red-team-advisory '));
  if (!isKnownMachineBody(e.body.replace(`Head \`${label}\``, `Head \`${marker.fromSha.slice(0, 12)}\``), e)) return false;
  const sources = new Map();
  for (const c of earlier.filter(isTrustedMarkerAuthor)) {
    const m = parseVerdictCarriedMarker(c.body);
    if (!m || !/^(?:<!-- review-verdict-carried |<!-- we:red-team-gate )/.test(c.body)) continue;
    if (sources.has(m.toSha) && sources.get(m.toSha) !== m.fromSha) return false;
    sources.set(m.toSha, m.fromSha);
  }
  let h = marker.fromSha;
  const visited = new Set();
  for (let n = 0; n < 32; n++) {
    if (visited.has(h) || !sources.has(h)) return false;
    visited.add(h); h = sources.get(h);
    if (h.startsWith(label)) return earlier.some(c => isTrustedMarkerAuthor(c)
      && gate.parseRedTeamComment(c.body)?.rev === h && tail(c.body) === tail(adv));
  }
  return false;
}
// The 44 negatives were first run against previousD3 and failed by assertion.
const amendedRecord = (cs, reviews) => latestAcceptRecord(cs, reviews);

const amendedCases = [
  ['W1 link with prose appended after its carried advisory', () => { const cs = chain(); cs[3].body += '\n\nPlease hold this.'; return cs; }],
  ['W2 link carrying a blocking advisory', () => { const cs = chain(); cs[3] = hop(A, B, rich(B, true)); return cs; }],
  ...['sent-back', 'rev', 'extra'].map(mode => [`W3 link with malformed gate prefix: ${mode}`, () => {
    const cs = chain(); let prefix = gatePrefix(B);
    if (mode === 'sent-back') prefix = prefix.replace('card-queued', 'sent-back');
    if (mode === 'rev') prefix = gatePrefix(D);
    if (mode === 'extra') prefix += ' extra';
    cs[3].body = `${prefix}\n${cs[3].body}`; return cs;
  }]),
  ['W4 origin first line with extra text after the marker', () => { const cs = chain(); cs[1].body = cs[1].body.replace('-->\n', '--> (copy)\n'); return cs; }],
  ['W5 link advisory text differs from E (mixed run)', () => { const cs = chain(); cs.splice(2, 0, chainComment(rich(A))); cs[4] = hop(A, B, rich(B)); return cs; }],
  ['W6 link with a different Head label', () => { const cs = chain(); cs[3] = hop(A, B, clean(B, B.slice(0, 12))); return cs; }],
  ['W7 link without a carried advisory', () => { const cs = chain(); cs[3].body = cs[3].body.split('\n').slice(0, 2).join('\n'); return cs; }],
  ['W8 one foreign result id everywhere', () => gatedChain('0'.repeat(16))],
  ...[3, 5].map(index => [`W9 gate prefix for another PR at ${index}`, () => { const cs = chain(); cs[index].body = `${gatePrefix(index === 3 ? B : C, resultId, chainPr + 1)}\n${cs[index].body}`; return cs; }]),
  ['W10 standalone window gate for another PR', () => withWindow(gateRecord(B, resultId, chainPr + 1))],
  ['R1 reversed links', () => { const cs = chain(); return [cs[0], cs[1], hop(B, C), hop(A, B), stamp(D), hop(C, D)]; }],
  ['R2 late origin', () => { const cs = chain(); return [cs[0], cs[2], cs[3], cs[1], cs[4], cs[5]]; }],
  ['R3 cycle on the selected path', () => { const cs = chain(); cs.splice(4, 0, hop(B, A), hop(A, B)); return cs; }],
  ['R4 origin after link by index, before it by createdAt', () => { const cs = chain(); cs[1].createdAt = '2026-10-31T00:00:00Z'; return [cs[0], cs[2], cs[3], cs[1], cs[4], cs[5]]; }],
  ['R5 cycle back to E destination', () => { const cs = chain(); return [...cs.slice(0, 4), stamp(A), hop(B, A)]; }],
  ['R6 earlier envelope to E destination from another source', () => [hop(D, C), ...chain()]],
  ['R7 hold moved before origin by a permutation', () => {
    const cs = withWindow(chainComment('🔁 review — changes requested')).map((c, id) => ({ ...c, id: id + 1 }));
    return [cs[4], ...cs.slice(0, 4), ...cs.slice(5)];
  }],
  ['S1 stale clean origin', () => { const cs = chain(); cs.splice(2, 0, chainComment(rich(A))); return cs; }],
  ['S1b stale clean origin followed by fresh accept', () => { const cs = chain(); cs.splice(2, 0, chainComment(rich(A, true)), { ...cs[0] }); return cs; }],
  ['S2 changes requested on intermediate head', () => withWindow(chainComment('🔁 review — changes requested'))],
  ['S3 newer different run on intermediate head', () => withWindow(chainComment(rich(B)))],
  ['S3 sent-back gate on intermediate head', () => withWindow(gateRecord(B).body && chainComment(gateRecord(B).body.replace('card-queued', 'sent-back')))],
  ['S3 different-result gate on intermediate head', () => withWindow(gateRecord(B, '0'.repeat(16)))],
  ['S4 restamp to non-path head', () => withWindow(stamp(D))],
  ...['📌 review — acceptance re-stamped', '🔔 conveyor — note'].map(body => [`S6 untrusted ${body}`, () => withWindow({ ...stamp(B), body: `${body}\n<!-- reviewed-sha: ${B} -->`, author: { login: 'mallory' } })]),
  ...['🔁 review — changes requested', '🔧 conveyor fix — re-armed for re-review', 'unknown human comment'].map(body => [`S7 hold between accept and origin: ${body}`, () => { const cs = chain(); cs.splice(1, 0, chainComment(body)); return cs; }]),
  ['S7 no base accept, only restamp', () => { const cs = chain(); cs[0] = stamp(A); return cs; }],
  ['S8 no review channel', chain, undefined],
  ['S5 unreadable reviews', chain, null],
  ['S5 formal objection then approval before restamp', () => {
    const cs = chain(); cs[4].createdAt = '2026-11-03T00:00:00Z'; return cs;
  }, [{ state: 'COMMENTED', submitted_at: '2026-11-02T00:00:00Z', user: { login: 'operator' } },
    { state: 'APPROVED', submitted_at: '2026-11-02T01:00:00Z', user: { login: 'operator' } }]],
  ...[undefined, 'garbled'].map(createdAt => [`S9 base accept time ${createdAt}`, () => { const cs = chain(); cs[0].createdAt = createdAt; return cs; }]),
  ...[undefined, 'garbled', '2026-11-01T00:00:00Z'].flatMap(time => ['submitted_at', 'submittedAt'].map(key =>
    [`S9 COMMENTED review ${key}=${time}`, chain, [{ state: 'COMMENTED', [key]: time }]])),
];

describe('multi-hop carry chain — amended D3 red tests', () => {
  beforeEach(() => vi.spyOn(gate, 'readConfirmedBreaks').mockReturnValue({ value: {
    ...gate.CONFIRMED_BREAKS_DEFAULTS, findingClasses: { 'live-reproduced': 'fix-now', 'theoretical-race': 'fix-now' },
  } }));
  afterEach(() => vi.restoreAllMocks());
  it.each(amendedCases)('%s', (_name, build, reviews = []) => {
    const cs = build();
    // An explicit undefined review channel must not become the default [] here.
    const evidence = _name.startsWith('S8') ? undefined : reviews;
    expect(previousD3(cs), 'the previous D3 admitted this full thread').toBe(true);
    expect(amendedRecord(cs, evidence).laterVerdict).toBe(true);
  });
  it.each([
    ['base', chain, []], ['real-id gate control', gatedChain, []],
    ['COMMENTED strictly before accept', chain, [{ state: 'COMMENTED', submittedAt: '2026-10-31T23:59:59Z' }]],
    ['fresh accept after hold', () => { const cs = chain(); cs.splice(1, 0, chainComment('🔁 review — changes requested'), { ...cs[0] }); return cs; }, []],
    ['R7 no-id caller precondition: hold moved before accept', () => [chainComment('🔁 review — changes requested'), ...chain()], []],
  ])('paired control: %s', (_name, build, reviews) => expect(latestAcceptRecord(build(), reviews).laterVerdict).toBe(false));
});

describe('carried advisory across a multi-hop carry chain', () => {
  it('keeps a second-generation carry non-blocking with formal-review evidence', () => {
    expect(latestAcceptRecord(chain(), [])).toMatchObject({ sha: C, laterVerdict: false });
  });
  it('keeps the third generation non-blocking', () => {
    expect(latestAcceptRecord([...chain(), stamp(D), hop(C, D)], [])).toMatchObject({ sha: D, laterVerdict: false });
  });
  it('accepts a gate-prefixed chain and normalized CRLF', () => {
    expect(latestAcceptRecord(gatedChain().map(c => ({ ...c, body: c.body.replaceAll('\n', '\r\n') })), []).laterVerdict).toBe(false);
  });
  it('accepts the latest of two identical origin runs', () => {
    const cs = chain(); cs.splice(2, 0, { ...cs[1] });
    expect(latestAcceptRecord(cs, []).laterVerdict).toBe(false);
  });
  it('keeps the context-free numbering consumer strict', () => expect(isKnownMachineBody(chain().at(-1).body, trusted)).toBe(false));
  const mutations = [
    ['a label off the chain', cs => { cs.at(-1).body = cs.at(-1).body.replace('Head `aaaaaaaaaaaa`', 'Head `ffffffffffff`'); }],
    ['an untrusted link', cs => { cs[3].author = { login: 'mallory' }; }],
    ['a missing origin', cs => { cs.splice(1, 1); }],
    ['an untrusted origin', cs => { cs[1].author = { login: 'mallory' }; }],
    ['an origin for another PR', cs => { cs[1].body = cs[1].body.replace('pr=6549', 'pr=6550'); }],
    ['an origin differing by one byte', cs => { cs[1].body = cs[1].body.replace('reported nothing', 'reported Nothing'); }],
    ['an envelope before its link regardless of time', cs => { const link = cs.splice(3, 1)[0]; link.createdAt = '2026-10-01T00:00:00Z'; cs.push(link); }],
    ['a global conflicting source off the selected path', cs => { cs.unshift(hop(A, D), hop(B, D)); }],
    ['a hold appended to E', cs => { cs.at(-1).body += '\nPlease hold.'; }],
    ...['prose\n', '> ', '```\n'].map(prefix => [`a quoted link: ${prefix}`, cs => { cs[3].body = prefix + cs[3].body; }]),
    ['a link missing the fixed sentence', cs => { cs[3].body = cs[3].body.replace('Review verdict carried across an identical contribution.\n', ''); }],
    ['a revisited head off the path (n2)', cs => { cs.splice(4, 0, hop(C, A)); cs.push(stamp(D), hop(C, D)); }],
    ['a missing gate result id', cs => { cs[3].body = `${gatePrefix(B, null)}\n${cs[3].body}`; }],
    ['manifest baseline hold inside a known machine note', cs => { cs.splice(4, 0, chainComment('🔔 conveyor — manifest baseline mismatch')); }],
  ];
  it.each(mutations)('refuses %s', (_name, mutate) => {
    const cs = chain(); mutate(cs); expect(latestAcceptRecord(cs, []).laterVerdict).toBe(true);
  });
  it.each([32, 33])('bounds predecessor links at 32: %s', count => {
    const cs = chain().slice(0, 2); let from = A;
    for (let n = 1; n <= count; n++) {
      const to = n.toString(16).padStart(40, '0'); cs.push(stamp(to), hop(from, to)); from = to;
    }
    cs.push(stamp(C), hop(from, C));
    expect(latestAcceptRecord(cs, []).laterVerdict).toBe(count === 33);
  });
  it('holds on malformed context rather than throwing', () => {
    const e = chain().at(-1);
    expect(isKnownMachineBody(e.body, e, { earlier: null, reviews: [] })).toBe(false);
    expect(isKnownMachineBody(e.body, e, { get earlier() { throw Error('malformed marker context'); }, reviews: [] })).toBe(false);
  });
  it('allows the strict machine shapes in the recorded windows', () => {
    const cs = chain(); cs.splice(4, 0,
      chainComment('<!-- drain-skip-reason -->\nWaiting for the queue.'),
      chainComment(`<!-- we-drain-enqueue-clearance head=${B} -->\n**Drain enqueue clearance** — the drain judged head \`${B.slice(0, 12)}\` ready (every drain gate passed: couple whole, blockedBy landed) and enqueued it on GitHub's merge queue (xtpxusq). The \`merge-gate\` check reads this for its couple-whole / blocked-by gates.`),
      chainComment('<!-- approval-prevention-filed:' + B + ' -->\nFiled the prevention guard(s) owed by o/n#1\'s independent review, mechanically, on approval (operator rule, 2026-09-27) — backlog/1-test.md (#1).'));
    expect(latestAcceptRecord(cs, []).laterVerdict).toBe(false);
  });
});

describe('multi-hop carry chain — spoofed machine notes and origin acceptances', () => {
  // All evidence is in memory; the clean advisory has no findings or policy IO.
  const proof = cs => {
    const e = cs.at(-1);
    return {
      machine: isKnownMachineBody(e.body, e, { earlier: cs.slice(0, -1), reviews: [] }),
      laterVerdict: latestAcceptRecord(cs, []).laterVerdict,
      carriable: findCarriableVerdict({ comments: cs, headSha: D, pr: chainPr, reviews: [] }),
    };
  };
  const held = { machine: false, laterVerdict: true, carriable: null };

  it.each([false, true])('keeps complete producer restamps carriable (human clearance: %s)', async human => {
    const { buildVerdictComment } = await import('../../review-set-label.mjs');
    const cs = chain();
    for (const [index, from, headSha] of [[2, A, B], [4, B, C]]) cs[index].body = buildVerdictComment({
      to: 'restamp', actor: 'fixture-reviewer', headSha, clearerId: 'fixture-session',
      reason: `identical whitespace-sensitive contribution patch; from ${from}; patch-id ${'e'.repeat(40)}`,
      reviewedDiff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n',
      independence: { independent: false, reason: 'fixture identity unavailable' },
      humanClearance: human ? { actor: 'fixture-operator', sha: A, sourceId: 'IC_fixture' } : null,
    });
    expect(proof(cs)).toMatchObject({ machine: true, laterVerdict: false, carriable: { sha: C } });
  });

  it.each([
    '🔔 conveyor — note\n🔁 review — changes requested\nDo not carry this acceptance.',
    '🔔 conveyor — note\nDo not carry this acceptance.',
    `📌 review — acceptance re-stamped\n<!-- reviewed-sha: ${B} -->\nDo not carry this acceptance.`,
    `📌 review — acceptance re-stamped after a rebase (no new review)\n\nRecorded by fixture\u2028Do not carry this acceptance.\n\n<!-- reviewed-sha: ${B} -->`,
    '<!-- drain-skip-reason -->\nWaiting for the queue.\nDo not carry this acceptance.',
  ])('refuses a window note recognised only by its prefix: %s', body => {
    expect(proof(withWindow(chainComment(body)))).toEqual(held);
  });

  it.each([
    '\n🔁 review — changes requested\nDo not carry this acceptance.',
    '\n🔁 human review — changes requested\nDo not carry this acceptance.',
    '\nreview paused: Do not carry this acceptance.',
    '\nmanifest baseline mismatch',
    '\u2028🔁 review — changes requested\nDo not carry this acceptance.',
    ' 🔁 review — changes requested. Do not carry this acceptance.',
    '\n> 🔁 review — changes requested\nDo not carry this acceptance.',
  ])('refuses a hold beneath the origin accepted heading: %s', hold => {
    const cs = chain();
    cs[0].body += hold;
    expect(proof(cs)).toEqual(held);
  });
});
