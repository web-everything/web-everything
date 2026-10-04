import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseVerdictComment,
  deriveRecord,
  deriveRecords,
  parseClaimMarkers,
  evaluateClaim,
  checkClaims,
  assertedAppearsInProse,
  normalizeNumberWords,
  ghCommentFetcher,
  prsReferenced,
  parseArgv,
  maskCodeSpans,
  METRICS,
  main,
} from '../review-log-claims.mjs';

/*
 * THE FIXTURES ARE THE REAL RECORD, transcribed from `gh pr view <n> --json comments` on the four PRs the
 * review-log entry behind #3336 got wrong (#1569–#1572, the four-way split of the review-efficacy filing).
 * Bodies are abridged in their PROSE and exact in their STRUCTURE — headings, panel table, findings header,
 * group headers, bullets, the `Net basis:` line — because structure is the only thing the parser reads.
 *
 * Every expectation below is the figure the entry's own retraction re-derived. That is the point: the module
 * has to reproduce the corrections a human had to make twice, from the same source, mechanically.
 */

const verdict = ({
  decision = 'changes', lens = 'correctness', netFiles = 8, groups = [], at = '2026-08-26T15:00:00Z',
} = {}) => {
  const total = groups.reduce((n, g) => n + g.count, 0);
  const heading = decision === 'changes' ? '🔁 review — changes requested' : '✅ review — accepted';
  const body = [
    heading,
    '',
    'Recorded by operator via the declared `review-pr` operation (#3035).',
    '',
    '## Human review verdict — web-everything/web-everything#1569',
    '',
    '### Panel verdicts',
    '',
    '| lens | weight | verdict |',
    '| --- | --- | --- |',
    `| ${lens} | mandatory | ${decision === 'changes' ? 'changes' : 'accept'} |`,
    '',
    `### Findings (${total})`,
    '',
    ...groups.flatMap((g) => [
      `**${g.category}** (${g.count})`,
      ...Array.from({ length: g.count }, (_, i) =>
        `- \`scripts/thing.mjs:${100 + i}\` — a finding. _[CONFIRMED]_ _[impact if unfixed: degraded]_`
        + '\n  - _Prevention (captured):_ a sub-bullet that must NOT be counted as a finding.'),
    ]),
    '',
    '---',
    '',
    `**Decision:** \`${decision}\` — recorded by operator.`,
    `Net basis: \`435f3519..c63f7293\` (rev \`origin/lane/x\` at review time) — ${netFiles} net changed file(s)`,
    ' vs current main (#2450), not `gh pr diff`\'s three-dot list.',
  ].join('\n');
  return { body, createdAt: at };
};

const parkNotice = { body: '<!-- drain-park-reason -->\n⏸ **Parked for review by the drain**\n\nheld — a review hold stands.', createdAt: '2026-08-26T13:12:33Z' };
const notesComment = { body: '### Independent review round — findings not carried by the juror\'s table above\n\nVerdict **changes**, on two findings.\n\n### Findings (2)\n\n**prose** (2)\n- a\n- b', createdAt: '2026-08-26T14:12:55Z' };
const restamp = { body: '📌 review — acceptance re-stamped after a rebase (no new review)\n\nRecorded by operator.', createdAt: '2026-08-26T16:46:18Z' };
const humanClear = { body: '✅ review — `review:human` cleared via the sanctioned path\n\nCleared by chalbert.', createdAt: '2026-08-26T17:00:00Z' };

/** #1569 as recorded: two pre-split rounds (120 then 123 files), two post-split (8 then 13). */
const PR_1569 = [
  parkNotice,
  verdict({ decision: 'changes', lens: 'correctness', netFiles: 120, at: '2026-08-26T13:15:50Z', groups: [{ category: 'coverage', count: 1 }, { category: 'claim-accuracy', count: 1 }, { category: 'correctness', count: 1 }] }),
  verdict({ decision: 'changes', lens: 'claim-accuracy', netFiles: 123, at: '2026-08-26T14:12:07Z', groups: [{ category: 'claim-accuracy', count: 3 }] }),
  notesComment,
  verdict({ decision: 'changes', lens: 'correctness', netFiles: 8, at: '2026-08-26T16:40:02Z', groups: [{ category: 'test-coverage', count: 1 }] }),
  verdict({ decision: 'accepted', lens: 'correctness', netFiles: 13, at: '2026-08-26T17:15:33Z', groups: [] }),
];
/** #1570 — two rounds, then a re-stamp that is NOT a round. */
const PR_1570 = [
  verdict({ decision: 'changes', netFiles: 16, at: '2026-08-26T15:25:26Z', groups: [{ category: 'data-consistency', count: 2 }] }),
  verdict({ decision: 'accepted', netFiles: 16, at: '2026-08-26T15:44:18Z', groups: [{ category: 'numeric-consistency', count: 1 }] }),
  restamp,
];
const PR_1571 = [
  verdict({ decision: 'changes', netFiles: 98, at: '2026-08-26T15:23:02Z', groups: [{ category: 'test-coverage', count: 1 }] }),
  verdict({ decision: 'changes', netFiles: 98, at: '2026-08-26T16:38:39Z', groups: [{ category: 'coverage', count: 1 }, { category: 'correctness', count: 1 }, { category: 'test-coverage', count: 1 }] }),
  verdict({ decision: 'accepted', netFiles: 102, at: '2026-08-26T17:06:17Z', groups: [{ category: 'correctness', count: 2 }] }),
  restamp,
];
const PR_1572 = [
  verdict({ decision: 'changes', netFiles: 4, at: '2026-08-26T15:29:40Z', groups: [{ category: 'override-reachability', count: 1 }, { category: 'verdict-classification-mismatch', count: 1 }] }),
  verdict({ decision: 'changes', netFiles: 4, at: '2026-08-26T15:30:59Z', groups: [{ category: 'correctness', count: 2 }] }),
  verdict({ decision: 'changes', netFiles: 4, at: '2026-08-26T15:32:20Z', groups: [{ category: 'correctness', count: 1 }] }),
  verdict({ decision: 'changes', netFiles: 4, at: '2026-08-26T17:01:27Z', groups: [{ category: 'correctness', count: 2 }] }),
  verdict({ decision: 'accepted', netFiles: 8, at: '2026-08-26T17:33:38Z', groups: [] }),
  restamp,
];

const RECORDS = new Map([
  [1569, deriveRecord(1569, PR_1569)],
  [1570, deriveRecord(1570, PR_1570)],
  [1571, deriveRecord(1571, PR_1571)],
  [1572, deriveRecord(1572, PR_1572)],
]);

const check = (markdown, records = RECORDS) => checkClaims([{ file: 'card.md', content: markdown }], records);
const one = (markdown, records = RECORDS) => evaluateClaim(parseClaimMarkers(markdown)[0], records);

describe('#3336 — reading the verdict record out of the comment stream', () => {
  it('#3336 counts only the two headings that ARE a review round, never the label bookkeeping', () => {
    expect(VERDICT_KINDS(PR_1570)).toEqual(['changes', 'accepted', 'restamp']);
    // The re-stamp says "no new review" in its own heading; folding it in would answer a question about
    // review effort with a number about label churn.
    expect(deriveRecord(1570, PR_1570).rounds).toHaveLength(2);
    expect(deriveRecord(1570, PR_1570).nonRounds.map((n) => n.kind)).toEqual(['restamp']);
    expect(deriveRecord(0, [humanClear]).rounds).toHaveLength(0);
  });

  it('#3336 ignores a drain park notice and an independent reviewer-notes comment', () => {
    // The entry behind this item counted findings from verdicts on one side and verdicts PLUS a notes
    // comment on the other, with neither basis stated. This module has one basis, always.
    expect(parseVerdictComment(parkNotice)).toBeNull();
    expect(parseVerdictComment(notesComment)).toBeNull();
    expect(deriveRecord(1569, PR_1569).rounds).toHaveLength(4);
  });

  it('#3336 counts a finding once — sub-bullets like `_Prevention (captured):_` are not findings', () => {
    const [round] = deriveRecord(1569, PR_1569).rounds;
    expect(round.findings).toBe(3);
    expect(round.groups).toEqual([
      { category: 'coverage', count: 1 }, { category: 'claim-accuracy', count: 1 }, { category: 'correctness', count: 1 },
    ]);
  });

  it('#3336 reads the net changed file count the round recorded as its basis', () => {
    expect(deriveRecord(1569, PR_1569).rounds.map((r) => r.netFiles)).toEqual([120, 123, 8, 13]);
  });

  it('#3336 refuses to answer when the comment disagrees with ITSELF about its finding count', () => {
    const tampered = { body: verdict({ groups: [{ category: 'correctness', count: 2 }] }).body.replace('### Findings (2)', '### Findings (9)') };
    const round = parseVerdictComment(tampered);
    expect(round.findings).toBeNull();
    expect(round.findingsNote).toMatch(/header says 9, group counts sum to 2/);
    // ...and every claim resting on it is UNKNOWN, never a mismatch.
    expect(evaluateClaim(parseClaimMarkers('9 findings <!-- claim: findings(9)=9 -->')[0],
      new Map([[9, deriveRecord(9, [tampered])]])).status).toBe('unknown');
  });
});

describe('#3336 — re-deriving the three claims the entry got wrong', () => {
  // This title previously said "the record gives 2 / 2 / 3 / 5" while the assertion below it read
  // toEqual([4, 2, 3, 5]) — a title contradicted by its own test. The 2 counted only #1569's two post-split
  // rounds; `rounds()` counts all four. The title now states the figure the assertion actually pins.
  it('#3336 contradicts "cleared in one round each": the record gives 4 / 2 / 3 / 5', () => {
    expect([1569, 1570, 1571, 1572].map((p) => METRICS.rounds.of(RECORDS.get(p).rounds)))
      .toEqual([4, 2, 3, 5]);
    const wrong = one('the split cleared in **one** round each <!-- claim: rounds(1570)=1 -->');
    expect(wrong.status).toBe('mismatch');
    expect(wrong.derived).toBe(2);
    expect(wrong.message).toMatch(/claims rounds = 1; the verdict record gives 2/);
    expect(one('#1572 took **5** rounds <!-- claim: rounds(1572)=5 -->').status).toBe('ok');
  });

  it('#3336 contradicts "found nine wrong figures": the record produces four', () => {
    const nine = one('two rounds found **nine** wrong figures <!-- claim: findings(1569; claim-accuracy)=9 -->');
    expect(nine.status).toBe('mismatch');
    expect(nine.derived).toBe(4); // 1 categorised in the 13:15 round + 3 in the 14:12 round.
    expect(one('two rounds found **four** wrong figures <!-- claim: findings(1569; claim-accuracy)=4 -->').status).toBe('ok');
  });

  it('#3336 contradicts "100 files": the pre-split diff was 120, then 123', () => {
    expect(one('the pre-split diff was **100** files <!-- claim: files(1569#1)=100 -->').derived).toBe(120);
    expect(one('**120** net changed files at the first verdict <!-- claim: files(1569#1)=120 -->').status).toBe('ok');
    expect(one('and **123** at the second <!-- claim: files(1569#2)=123 -->').status).toBe('ok');
  });

  it('#3336 REFUSES "no test finding at all" rather than answering it — the mis-tag trap', () => {
    // A category is free text the reviewer chose, so an absent group header cannot be told from the same
    // finding tagged differently. Answering `0` would stamp VERIFIED on this item's own defect class.
    const refused = one('no test finding at all <!-- claim: findings(1569#1; test-coverage)=0 -->');
    expect(refused.status).toBe('invalid');
    expect(refused.message).toMatch(/not checkable/);
    // The unfiltered count is checkable, and it is what the author should assert instead.
    expect(one('that round recorded **3** findings <!-- claim: findings(1569#1)=3 -->').status).toBe('ok');
    // A POSITIVE category count is checkable — and #1569 round 3 did carry a test finding.
    expect(one('**1** test finding <!-- claim: findings(1569#3; test-coverage)=1 -->').status).toBe('ok');
  });

  it('#3336 sums across PRs and says so — a distributive "each" is not expressible', () => {
    expect(one('**14** rounds across the four <!-- claim: rounds(1569,1570,1571,1572)=14 -->').status).toBe('ok');
    expect(one('**3** accepted <!-- claim: accepted(1570,1571,1572)=3 -->').status).toBe('ok');
    // Written as 9 first, from a head count; the record gives 10 (3 + 1 + 2 + 4). Kept as the failing half
    // of this expectation because it is this item's own defect class, made by its own author, on its own data.
    expect(one('**9** bounces <!-- claim: changes(1569,1570,1571,1572)=9 -->').status).toBe('mismatch');
    expect(one('**10** bounces <!-- claim: changes(1569,1570,1571,1572)=10 -->').derived).toBe(10);
  });
});

describe('#3336 — recognising a claim: marked, never sniffed', () => {
  it('#3336 examines NOTHING that is not marked, whatever the prose says', () => {
    const prose = [
      'The split cleared in one round each — #1570 merged, #1569 and #1571 accepted.',
      'It carried 100 files across five review rounds and found nine wrong figures.',
      'Both pre-split verdicts recorded no test finding at all. 22.5% of 129 merged with no verdict.',
      '| PR | rounds | outcome |', '| #1572 | 5 | merged |',
    ].join('\n');
    // Every sentence above is a quantitative claim, and three of them are the exact wrong ones. A sniffer
    // would fire here; this fires zero times, because the author marked nothing.
    expect(parseClaimMarkers(prose)).toEqual([]);
    expect(check(prose)).toMatchObject({ checked: 0, errors: [], warnings: [] });
  });

  it('#3336 reports an unreadable marker as an ERROR — a typo must not silently disable a check', () => {
    expect(one('5 rounds <!-- claim: rouunds(1572)=5 -->').message).toMatch(/unknown metric `rouunds`/);
    expect(one('5 rounds <!-- claim: rounds(#1572)=5 -->').status).toBe('ok'); // a leading `#` is fine
    expect(one('5 rounds <!-- claim: rounds(PR-1572)=5 -->').message).toMatch(/cannot read PR argument/);
    expect(one('5 rounds <!-- claim: rounds()=5 -->').message).toMatch(/no PR number given/);
    expect(one('5 rounds <!-- claim: rounds(1572#2)=5 -->').message).toMatch(/asks nothing/);
    expect(one('8 files <!-- claim: files(1569)=8 -->').message).toMatch(/needs a `#round` selector/);
    expect(one('8 files <!-- claim: files(1569,1570)=8 -->').message).toMatch(/recorded per round/);
    expect(one('5 rounds <!-- claim: rounds(1572; correctness)=5 -->').message).toMatch(/takes no category filter/);
  });

  it('#3336 finds each marker at its own line and file, for a citable error', () => {
    const doc = ['# Card', '', '#1570 took 2 rounds <!-- claim: rounds(1570)=2 -->', '', '#1571 took 3 <!-- claim: rounds(1571)=3 -->'].join('\n');
    expect(parseClaimMarkers(doc).map((c) => c.lineNo)).toEqual([3, 5]);
    const { results } = check(doc);
    expect(results.map((r) => `${r.file}:${r.lineNo}:${r.status}`)).toEqual(['card.md:3:ok', 'card.md:5:ok']);
  });
});

describe('#3336 — a marker shown as an EXAMPLE documents the grammar; it asserts nothing', () => {
  // The regression this pins: the card specifying this checker spells the grammar out in backticks, so the
  // tree sweep reported as "0 markers, exit 0" in fact found 1 and exited 1 — the module failing its own
  // acceptance criterion, "it fires on nothing it was not asked to check".
  it('#3336 a marker inside an inline code span is not a claim', () => {
    expect(parseClaimMarkers('mark it as `<!-- claim: rounds(1572)=5 -->` in your card')).toEqual([]);
    expect(parseClaimMarkers('``<!-- claim: rounds(1572)=5 -->``')).toEqual([]);
  });

  it('#3336 a marker inside a fenced block is not a claim', () => {
    for (const f of ['```', '~~~', '```markdown']) {
      expect(parseClaimMarkers(`before\n${f}\n<!-- claim: rounds(1572)=5 -->\n${f.slice(0, 3)}\nafter`)).toEqual([]);
    }
  });

  it('#3336 a marker in running prose is still read exactly as before', () => {
    const claims = parseClaimMarkers('PR #1572 took **5** rounds. <!-- claim: rounds(1572)=5 -->');
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ metric: 'rounds', asserted: 5, invalid: null, lineNo: 1 });
  });

  it('#3336 masking preserves offsets, so the line number and the prose stay exact', () => {
    const doc = 'a `<!-- claim: rounds(1)=1 -->`\n\nPR #1572 took **5** rounds <!-- claim: rounds(1572)=5 -->\n';
    expect(maskCodeSpans(doc).split('\n').map((l) => l.length)).toEqual(doc.split('\n').map((l) => l.length));
    const claims = parseClaimMarkers(doc);
    expect(claims).toHaveLength(1);
    expect(claims[0].lineNo).toBe(3);
    expect(claims[0].line).toContain('PR #1572 took **5** rounds'); // read from the ORIGINAL, not the mask
  });

  it('#3336 the real tree sweeps clean — the acceptance criterion, run for real', () => {
    const mdIn = (dir) => readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f));
    const files = [...mdIn('backlog'), ...mdIn('docs/agent'), 'AGENTS.md'];
    expect(files.length).toBeGreaterThan(3000);
    const marked = files.flatMap((f) => parseClaimMarkers(readFileSync(f, 'utf8')));
    expect(marked).toEqual([]); // 0 markers, 0 errors — nothing is sniffed out of prose
  });
});

describe('#3336 — the marker cannot drift from the sentence it annotates', () => {
  it('#3336 FAILS a marker whose figure the record agrees with but the prose does not', () => {
    const drifted = one('it cleared in **one** round <!-- claim: rounds(1570)=2 -->');
    expect(drifted.status).toBe('drift');
    expect(drifted.derived).toBe(2);
    expect(drifted.message).toMatch(/does not appear in the sentence it annotates/);
  });

  it('#3336 accepts the figure spelled as a word, bolded, or in a table cell', () => {
    expect(one('it took **two** rounds <!-- claim: rounds(1570)=2 -->').status).toBe('ok');
    expect(one('| #1570 | **2** | merged | <!-- claim: rounds(1570)=2 -->').status).toBe('ok');
    expect(normalizeNumberWords('zero of four cleared in one round')).toBe('0 of 4 cleared in 1 round');
  });

  it('#3336 will not let the marker satisfy its own echo check', () => {
    // Stripped first — otherwise `=2` inside the marker is itself a `2` on the line and every marker passes.
    expect(assertedAppearsInProse('it cleared in one round <!-- claim: rounds(1570)=2 -->', 2, '<!-- claim: rounds(1570)=2 -->')).toBe(false);
  });

  it('#3336 word-bounds the echo so an asserted 2 does not match inside 123', () => {
    expect(assertedAppearsInProse('the diff was 123 files', 2, '')).toBe(false);
    expect(assertedAppearsInProse('the diff was 123 files', 123, '')).toBe(true);
    expect(assertedAppearsInProse('22.5% of them', 5, '')).toBe(false);
  });
});

describe('#3336 — unknown is never wrong, and never zero', () => {
  it('#3336 warns (never errors) when the record cannot be read, and exits 0', () => {
    const { errors, warnings } = check('it took **2** rounds <!-- claim: rounds(4242)=2 -->');
    expect(errors).toEqual([]);
    expect(warnings[0]).toMatch(/no record read for PR #4242 — unknown, not wrong/);
  });

  it('#3336 does NOT let a failed `gh` read derive zero rounds', () => {
    const failing = ghCommentFetcher({ run: () => { throw new Error('gh: 403'); } });
    expect(failing(1569)).toBeNull();
    // A `[]` here would derive `rounds = 0` and turn an outage into a confident wrong answer.
    expect(deriveRecords([1569], failing).size).toBe(0);
    expect(ghCommentFetcher({ run: () => 'not json' })(1569)).toBeNull();
  });

  it('#3336 reports a round selector past the end of the record as unknown, not as a mismatch', () => {
    const past = one('the **9**th round <!-- claim: files(1570#9)=9 -->');
    expect(past.status).toBe('unknown');
    expect(past.message).toMatch(/records 2 round\(s\); there is no round #9/);
  });

  it('#3336 --strict promotes unknown to failure for a caller that guarantees the network', () => {
    const out = [];
    const doc = fileWith('it took **2** rounds <!-- claim: rounds(4242)=2 -->');
    const fetch = () => null;
    expect(main(['check', doc], { fetch, log: (m) => out.push(m), err: () => {} })).toBe(0);
    expect(main(['check', doc, '--strict'], { fetch, log: (m) => out.push(m), err: () => {} })).toBe(1);
  });
});

describe('#3336 — the CLI: derive reads, check asserts', () => {
  const fetch = (pr) => ({ 1569: PR_1569, 1570: PR_1570, 1571: PR_1571, 1572: PR_1572 })[pr] ?? null;

  it('#3336 `derive` prints the record and cannot fail — it asserts nothing', () => {
    const out = [];
    expect(main(['derive', '1572'], { fetch, log: (m) => out.push(m) })).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/PR #1572 — 5 recorded review round\(s\)/);
    expect(text).toMatch(/decision `accept`/);
    expect(text).toMatch(/`restamp`, NOT counted as a review round/);
  });

  it('#3336 `derive` says UNREADABLE rather than printing an empty record', () => {
    const out = [];
    main(['derive', '4242'], { fetch, log: (m) => out.push(m) });
    expect(out.join('\n')).toMatch(/PR #4242 — record UNREADABLE \(unknown, not empty\)/);
  });

  it('#3336 `check` exits 1 on a contradicted marker and 0 on a matching one', () => {
    const out = [];
    const log = (m) => out.push(m);
    expect(main(['check', fileWith('it cleared in **one** round <!-- claim: rounds(1570)=1 -->')], { fetch, log })).toBe(1);
    expect(out.join('\n')).toMatch(/❌ .*claims rounds = 1; the verdict record gives 2/);
    expect(main(['check', fileWith('it took **two** rounds <!-- claim: rounds(1570)=2 -->')], { fetch, log })).toBe(0);
  });

  it('#3336 `check` on an unmarked document says so, and exits 0', () => {
    const out = [];
    expect(main(['check', fileWith('The split cleared in one round each.')], { fetch, log: (m) => out.push(m) })).toBe(0);
    expect(out.join('\n')).toMatch(/nothing asserted, nothing checked/);
  });

  it('#3336 `-h` prints usage and exits 0, like `--help`', () => {
    for (const flag of ['-h', '--help']) {
      const out = [];
      const errs = [];
      expect(main([flag], { fetch, log: (m) => out.push(m), err: (m) => errs.push(m) })).toBe(0);
      expect(out.join('\n')).toMatch(/^review-log-claims — re-derive a quantitative review-log claim/);
      expect(errs).toEqual([]); // never the unknown-command branch
    }
  });

  it('#3336 a bare invocation still prints usage and exits 1 — no command is misuse', () => {
    const out = [];
    expect(main([], { fetch, log: (m) => out.push(m) })).toBe(1);
    expect(out.join('\n')).toMatch(/Marker grammar/);
  });

  it('#3336 `--repo` reaches `gh` in BOTH the space form and the `=` form', () => {
    // The regression: `--repo O/R` was dropped and `O/R` fell through to `derive`'s Number filter, so the
    // command read THIS repo and exited 0 — a confident answer about the wrong repository.
    for (const argv of [['derive', '1572', '--repo', 'cli/cli'], ['derive', '1572', '--repo=cli/cli']]) {
      const calls = [];
      const run = (bin, args) => { calls.push([bin, args]); return JSON.stringify({ comments: PR_1572 }); };
      const out = [];
      expect(main(argv, { run, log: (m) => out.push(m) })).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('gh');
      expect(calls[0][1]).toEqual(['pr', 'view', '1572', '--json', 'comments', '--repo', 'cli/cli']);
      expect(out.join('\n')).toMatch(/PR #1572 — 5 recorded review round\(s\)/);
    }
  });

  it('#3336 without `--repo`, `gh` is given no repo flag at all', () => {
    const calls = [];
    const run = (bin, args) => { calls.push(args); return JSON.stringify({ comments: PR_1572 }); };
    expect(main(['derive', '1572'], { run, log: () => {} })).toBe(0);
    expect(calls[0]).toEqual(['pr', 'view', '1572', '--json', 'comments']);
  });

  it('#3336 a valueless or mistyped flag is an ERROR, never a silent no-op', () => {
    for (const argv of [['derive', '1572', '--repo'], ['derive', '1572', '--repo='], ['derive', '1572', '--repo', '--json']]) {
      const errs = [];
      expect(main(argv, { fetch, log: () => {}, err: (m) => errs.push(m) })).toBe(1);
      expect(errs.join('\n')).toMatch(/--repo needs a value/);
    }
    const errs = [];
    expect(main(['derive', '1572', '--reppo=cli/cli'], { fetch, log: () => {}, err: (m) => errs.push(m) })).toBe(1);
    expect(errs.join('\n')).toMatch(/unknown flag `--reppo=cli\/cli`/);
  });

  it('#3336 parseArgv separates operands, flags and the repo value', () => {
    expect(parseArgv(['derive', '1', '2', '--json'])).toMatchObject({ repo: null, operands: ['derive', '1', '2'] });
    expect(parseArgv(['check', 'a.md', '--repo', 'o/r', '--strict']).operands).toEqual(['check', 'a.md']);
    expect(parseArgv(['check', 'a.md', '--repo', 'o/r']).repo).toBe('o/r');
    expect(parseArgv(['check', 'a.md', '--repo=o/r']).repo).toBe('o/r');
    // The value after `--repo` is consumed, so it can never be mistaken for a file to check.
    expect(parseArgv(['check', 'a.md', '--repo', 'o/r']).operands).not.toContain('o/r');
    expect([...parseArgv(['derive', '1', '--json', '--strict']).flags]).toEqual(['--json', '--strict']);
  });

  it('#3336 fetches each PR exactly once however many markers name it', () => {
    const claims = parseClaimMarkers([
      'a <!-- claim: rounds(1569)=4 -->', 'b <!-- claim: findings(1569)=7 -->', 'c <!-- claim: files(1570#1)=16 -->',
    ].join('\n'));
    expect(prsReferenced(claims)).toEqual([1569, 1570]);
    const seen = [];
    deriveRecords(prsReferenced(claims), (pr) => { seen.push(pr); return fetch(pr); });
    expect(seen).toEqual([1569, 1570]);
  });
});

/* Helpers kept at the foot so the expectations read first. */
function VERDICT_KINDS(comments) {
  return comments.map(parseVerdictComment).filter(Boolean).map((v) => v.kind);
}

let tmpSeq = 0;
function fileWith(content) {
  const dir = mkdtempSync(join(tmpdir(), 'review-log-claims-'));
  const file = join(dir, `card-${tmpSeq += 1}.md`);
  writeFileSync(file, content, 'utf8');
  return file;
}
