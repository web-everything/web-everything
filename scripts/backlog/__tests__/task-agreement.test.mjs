/**
 * @file scripts/backlog/__tests__/task-agreement.test.mjs
 * @description #5399 slice S1 (we:backlog/xj67z1d) — the ONE shared reader of a card's task agreement
 *   (`## Acceptance` + `## Non-goals`, numbered `- [A1] …` / `- [N1] …` items, legacy `## Done when` alias, the
 *   draft marker), the advise|enforce setting file, and the gates that must read `## Acceptance` exactly as they
 *   already read `## Done when` (check:standards rules, provenance escape zones, the codex-worker card reader,
 *   the orphan-card sweep). Fails before S1: the module does not exist and every gate keys on `## Done when` only.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCEPTANCE_HEADING, NON_GOALS_HEADING, AGREEMENT_DRAFT_MARKER, ACCEPTANCE_HEADING_RE,
  TASK_AGREEMENT_MODES, DEFAULT_TASK_AGREEMENT_MODE, TASK_AGREEMENT_POLICY_PATH,
  readTaskAgreement, renderTaskAgreementSkeleton, validateTaskAgreementPolicy,
} from '../task-agreement.mjs';
import { findMustWithoutDoneWhen, lintBacklogItemRendering, bodyDeliverablesMissingFromScope } from '../../check-standards-rules.mjs';
import { findUnresolvedIdentifiers } from '../../lib/citation-check.mjs';
import { parseCard } from '../../operations/codex-worker.mjs';
import { parseOrphanCard } from '../../operations/sweep-orphan-backlog-cards.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const CARD = [
  '---', 'kind: story', 'status: open', '---', '', '# Title', '', 'Digest.', '',
  '## Acceptance', '',
  '- [A1] **Executable** — `npm run test:unit -- x.test.mjs` fails before and passes after.',
  '- [A2] **Observable** — the hold reason appears',
  '  in the dispatch output.',
  '', '## Non-goals', '',
  '- [N1] Backfilling resolved cards.',
  '- [N2] n/a: nothing else is excluded.',
  '', '## Edge cases this change must handle', '', '1. **Untrusted text** — n/a: none.', '',
].join('\n');

describe('readTaskAgreement — canonical sections', () => {
  it('reads numbered Acceptance and Non-goals items with their ids, joining continuation lines', () => {
    const a = readTaskAgreement(CARD);
    expect(a.acceptance).toEqual([
      { id: 'A1', text: '**Executable** — `npm run test:unit -- x.test.mjs` fails before and passes after.' },
      { id: 'A2', text: '**Observable** — the hold reason appears in the dispatch output.' },
    ]);
    expect(a.nonGoals).toEqual([
      { id: 'N1', text: 'Backfilling resolved cards.' },
      { id: 'N2', text: 'n/a: nothing else is excluded.' },
    ]);
    expect(a).toMatchObject({ legacy: false, draft: false, problems: [] });
  });

  it('never throws on junk input and reports both sections missing', () => {
    for (const junk of [undefined, null, '', 42, '# just a title']) {
      const a = readTaskAgreement(junk);
      expect(a.acceptance).toEqual([]);
      expect(a.nonGoals).toEqual([]);
      expect(a.problems.map((p) => p.code).sort()).toEqual(['acceptance-missing', 'non-goals-missing']);
    }
  });

  it('ignores headings and items inside code fences', () => {
    const body = ['```md', '## Acceptance', '- [A1] fenced', '```', '', '## Non-goals', '', '- [N1] real'].join('\n');
    const a = readTaskAgreement(body);
    expect(a.acceptance).toEqual([]);
    expect(a.problems.map((p) => p.code)).toContain('acceptance-missing');
    expect(a.nonGoals).toEqual([{ id: 'N1', text: 'real' }]);
  });

  it('drops TODO and Hint lines, and a bare "none" / "n/a" non-goal, each as a problem', () => {
    const body = [
      '## Acceptance', '', '- [A1] **Executable** — TODO: a command that fails before this item lands.', '',
      'Hint: something.', '', '## Non-goals', '', '- [N1] none', '- [N2] n/a', '- [N3] TODO: what this does not do.',
    ].join('\n');
    const a = readTaskAgreement(body);
    expect(a.acceptance).toEqual([]);
    expect(a.nonGoals).toEqual([]);
    const codes = a.problems.map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['acceptance-todo', 'non-goals-todo', 'non-goals-bare-none', 'acceptance-empty', 'non-goals-empty']));
  });

  it('gives an un-numbered item a positional id and flags it; flags duplicate and wrong-prefix ids', () => {
    const body = ['## Acceptance', '', '- first', '- [A1] dup', '- [N3] wrong prefix', '', '## Non-goals', '', '1. plain numbered'].join('\n');
    const a = readTaskAgreement(body);
    expect(a.acceptance.map((x) => x.id)).toEqual(['A1', 'A1', 'N3']);
    expect(a.nonGoals).toEqual([{ id: 'N1', text: 'plain numbered' }]);
    const codes = a.problems.map((p) => `${p.code}:${p.section}`);
    expect(codes).toEqual(expect.arrayContaining([
      'missing-id:acceptance', 'duplicate-id:acceptance', 'wrong-id-prefix:acceptance', 'missing-id:non-goals',
    ]));
  });

  it('flags prose with no list item in a canonical section', () => {
    const a = readTaskAgreement('## Acceptance\n\nIt works.\n\n## Non-goals\n\n- [N1] x\n');
    expect(a.acceptance).toEqual([]);
    expect(a.problems.map((p) => p.code)).toEqual(expect.arrayContaining(['acceptance-not-a-list', 'acceptance-empty']));
  });

  it('skips an HTML comment that spans several lines, and keeps text after a one-line comment', () => {
    const card = [
      '## Acceptance', '',
      '<!-- authoring note', '- [A9] hidden inside the comment', 'still hidden -->',
      '- [A1] real item.', '<!-- one-line note -->', '<!-- inline --> - not an item', '',
      '## Non-goals', '', '- [N1] real non-goal.', '',
    ].join('\n');
    const a = readTaskAgreement(card);
    expect(a.acceptance.map((i) => i.id)).toEqual(['A1']);
    expect(a.nonGoals.map((i) => i.id)).toEqual(['N1']);
    expect(a.problems.map((p) => p.code)).not.toContain('acceptance-not-a-list');
  });

  it('accepts `## Acceptance criteria` and `## Non-goal` heading spellings', () => {
    const a = readTaskAgreement('## Acceptance criteria\n\n- [A1] a\n\n## Non-goal\n\n- [N1] b\n');
    expect(a.acceptance).toEqual([{ id: 'A1', text: 'a' }]);
    expect(a.nonGoals).toEqual([{ id: 'N1', text: 'b' }]);
  });
});

describe('readTaskAgreement — legacy `## Done when` alias', () => {
  it('reads Done when as Acceptance with positional ids A1..An, legacy: true, no missing-id problems', () => {
    const body = ['## Done when', '', '1. **Executable** — `cmd` passes.', '2. **Observable** — it shows.', '', 'Hint: drop me.', '', '## Non-goals', '', '1. Nothing old.'].join('\n');
    const a = readTaskAgreement(body);
    expect(a.legacy).toBe(true);
    expect(a.acceptance).toEqual([
      { id: 'A1', text: '**Executable** — `cmd` passes.' },
      { id: 'A2', text: '**Observable** — it shows.' },
    ]);
    expect(a.problems.filter((p) => p.section === 'acceptance')).toEqual([]);
  });

  it('reads a prose-only Done when as one item per paragraph', () => {
    const a = readTaskAgreement('## Done when\n\nThe page renders.\nIn both themes.\n\nThe test passes.\n');
    expect(a.acceptance).toEqual([{ id: 'A1', text: 'The page renders. In both themes.' }, { id: 'A2', text: 'The test passes.' }]);
    expect(a.legacy).toBe(true);
  });

  it('prefers `## Acceptance` when both headings exist, and reports the duplicate', () => {
    const a = readTaskAgreement('## Done when\n\n1. old\n\n## Acceptance\n\n- [A1] new\n');
    expect(a.legacy).toBe(false);
    expect(a.acceptance).toEqual([{ id: 'A1', text: 'new' }]);
    expect(a.problems.map((p) => p.code)).toContain('duplicate-section');
  });
});

describe('readTaskAgreement — draft marker', () => {
  it('exposes the marker under either heading as draft: true, without counting it as an item', () => {
    const body = `## Acceptance\n\n${AGREEMENT_DRAFT_MARKER}\n\n- [A1] a\n\n## Non-goals\n\n- [N1] b\n`;
    const a = readTaskAgreement(body);
    expect(a.draft).toBe(true);
    expect(a.acceptance).toEqual([{ id: 'A1', text: 'a' }]);
    expect(readTaskAgreement(`## Acceptance\n\n- [A1] a\n\n## Non-goals\n\n${AGREEMENT_DRAFT_MARKER}\n- [N1] b\n`).draft).toBe(true);
  });

  it('ignores the marker outside the two sections and inside a fence', () => {
    expect(readTaskAgreement(`${AGREEMENT_DRAFT_MARKER}\n\n## Acceptance\n\n- [A1] a\n`).draft).toBe(false);
    expect(readTaskAgreement(`## Acceptance\n\n\`\`\`\n${AGREEMENT_DRAFT_MARKER}\n\`\`\`\n- [A1] a\n`).draft).toBe(false);
  });
});

describe('the skeleton and the constants', () => {
  it('pins the section format and the draft marker', () => {
    expect(ACCEPTANCE_HEADING).toBe('## Acceptance');
    expect(NON_GOALS_HEADING).toBe('## Non-goals');
    expect(AGREEMENT_DRAFT_MARKER).toBe('<!-- agreement: draft -->');
    expect(ACCEPTANCE_HEADING_RE.test('Acceptance')).toBe(true);
    expect(ACCEPTANCE_HEADING_RE.test('Done when')).toBe(true);
    expect(ACCEPTANCE_HEADING_RE.test('Design')).toBe(false);
  });

  it('renders both sections in the numbered shape, keeping the `TODO: a command` placeholder the #4738 lint keys on', () => {
    const s = renderTaskAgreementSkeleton();
    expect(s.indexOf('## Acceptance')).toBeLessThan(s.indexOf('## Non-goals'));
    expect(s).toMatch(/^- \[A1\] \*\*Executable\*\* — TODO: a command/m);
    expect(s).toMatch(/^- \[N1\] TODO/m);
    const a = readTaskAgreement(s);
    expect(a.acceptance).toEqual([]);
    expect(a.nonGoals).toEqual([]);
    expect(a.problems.map((p) => p.code)).toEqual(expect.arrayContaining(['acceptance-todo', 'non-goals-todo']));
  });
});

describe('the advise|enforce setting', () => {
  it('ships as advise and validates', () => {
    expect(TASK_AGREEMENT_MODES).toEqual(['advise', 'enforce']);
    expect(DEFAULT_TASK_AGREEMENT_MODE).toBe('advise');
    const policy = JSON.parse(readFileSync(join(ROOT, TASK_AGREEMENT_POLICY_PATH), 'utf8'));
    expect(policy.mode).toBe('advise');
    expect(validateTaskAgreementPolicy(policy)).toEqual([]);
  });

  it('rejects an unknown mode, a missing mode and a non-object', () => {
    expect(validateTaskAgreementPolicy({ mode: 'off' }).length).toBeGreaterThan(0);
    expect(validateTaskAgreementPolicy({}).length).toBeGreaterThan(0);
    expect(validateTaskAgreementPolicy(null).length).toBeGreaterThan(0);
    expect(validateTaskAgreementPolicy(['advise']).length).toBeGreaterThan(0);
  });
});

describe('gates read `## Acceptance` exactly as `## Done when`', () => {
  it('Must-without-Done-when (#4438) counts a Must cited under ## Acceptance', () => {
    const body = '## Explicit MVP cut\n\n**Must**\n1. the reader\n\n## Acceptance\n\n- [A1] Must 1 holds.\n';
    expect(findMustWithoutDoneWhen(body)).toEqual([]);
  });

  it('the #4738 unfinished-acceptance lint fires on the placeholder under ## Acceptance', () => {
    const body = '# T\n\nThis has mutation proof.\n\n## Acceptance\n\n- [A1] **Executable** — TODO: a command that fails before.\n';
    const { errors } = lintBacklogItemRendering({ item: { id: 'x1', status: 'open' }, body });
    expect(errors.some((e) => /unfinished executable acceptance/.test(e))).toBe(true);
  });

  it('the scope-deliverables guard (#4448) reads ## Acceptance', () => {
    const body = '## Acceptance\n\n- [A1] `we:scripts/new-thing.mjs` exists.\n';
    expect(bodyDeliverablesMissingFromScope({ scope: ['we:scripts/other.mjs'] }, body)).toEqual(['we:scripts/new-thing.mjs']);
  });

  it('provenance lint treats ## Acceptance and ## Non-goals as escape zones', () => {
    const text = '## Acceptance\n\n- [A1] `notYetWritten` exists.\n\n## Non-goals\n\n- [N1] `neverBuilt` stays unbuilt.\n';
    expect(findUnresolvedIdentifiers(text, { resolves: () => false })).toEqual([]);
  });

  it('the codex-worker card reader takes ## Acceptance as the done-when text', () => {
    const card = parseCard('---\nscope: []\nstatus: open\n---\n# T\n\nDigest.\n\n## Acceptance\n\n- [A1] it works.\n\n## Non-goals\n\n- [N1] x\n');
    expect(card.digest).toBe('Digest.');
    expect(card.doneWhen).toContain('- [A1] it works.');
    expect(card.doneWhen).not.toContain('Non-goals');
  });

  it('the orphan sweep cuts the ## Acceptance boilerplate before hashing, as it does ## Done when', () => {
    const head = '---\nstatus: open\nkind: task\n---\n# T\n\nIntro.\n';
    const a = parseOrphanCard('backlog/xaaaaaa-t.md', `${head}\n## Acceptance\n\n- [A1] one\n`);
    const b = parseOrphanCard('backlog/xaaaaaa-t.md', `${head}\n## Acceptance\n\n- [A1] two\n`);
    expect(a.digestHash).toBe(b.digestHash);
  });
});

describe('readTaskAgreement — HTML comments are skipped before sections are found (review round 2)', () => {
  const REAL = ['## Acceptance', '', '- [A1] real item.', '', '## Non-goals', '', '- [N1] real non-goal.', ''];

  it('does not let commented-out Acceptance and Non-goals headings replace the real sections', () => {
    const card = [
      '<!-- old draft', '## Acceptance', '', '- [A1] obsolete', '', '## Non-goals', '', '- [N1] obsolete', '-->', '', ...REAL,
    ].join('\n');
    const a = readTaskAgreement(card);
    expect(a.acceptance).toEqual([{ id: 'A1', text: 'real item.' }]);
    expect(a.nonGoals).toEqual([{ id: 'N1', text: 'real non-goal.' }]);
    expect(a.problems).toEqual([]);
  });

  it('does not let a commented-out heading cut a real section short', () => {
    const card = ['## Acceptance', '', '- [A1] one.', '<!--', '## Foo', '-->', '- [A2] two.', '', '## Non-goals', '', '- [N1] x.'].join('\n');
    expect(readTaskAgreement(card).acceptance.map((i) => i.id)).toEqual(['A1', 'A2']);
  });

  it('ignores a fence marker inside a comment, and a comment marker inside a fence', () => {
    const inComment = ['<!--', '```', '-->', ...REAL].join('\n');
    expect(readTaskAgreement(inComment).problems).toEqual([]);
    const inFence = ['```', '<!--', '```', ...REAL].join('\n');
    expect(readTaskAgreement(inFence).problems).toEqual([]);
  });

  it('does not let a `<!--` quoted in prose or backticks swallow the rest of the card', () => {
    const intro = readTaskAgreement(['# T', '', 'The reader skips `<!--` blocks.', '', ...REAL].join('\n'));
    expect(intro.acceptance).toEqual([{ id: 'A1', text: 'real item.' }]);
    expect(intro.nonGoals).toEqual([{ id: 'N1', text: 'real non-goal.' }]);
    expect(intro.problems).toEqual([]);
    const item = readTaskAgreement('## Acceptance\n\n- [A1] skips `<!--` in code.\n- [A2] two.\n\n## Non-goals\n\n- [N1] x.\n');
    expect(item.acceptance.map((i) => i.id)).toEqual(['A1', 'A2']);
    expect(item.nonGoals.map((i) => i.id)).toEqual(['N1']);
  });

  it('does not open a comment on a heading line, and tolerates a stray close', () => {
    const a = readTaskAgreement(['## Acceptance', '', '- [A1] one.', '', '## Non-goals <!-- y', '- [N1] real.'].join('\n'));
    expect(a.nonGoals).toEqual([{ id: 'N1', text: 'real.' }]);
    expect(readTaskAgreement(['--> stray', ...REAL].join('\n')).problems).toEqual([]);
  });

  it('treats `<!-->` as an empty, already-closed comment', () => {
    const a = readTaskAgreement(['## Acceptance', '', '<!-->', '- [A1] one.', '- [A2] two.', '', '## Non-goals', '', '- [N1] x.'].join('\n'));
    expect(a.acceptance.map((i) => i.id)).toEqual(['A1', 'A2']);
    expect(a.nonGoals.map((i) => i.id)).toEqual(['N1']);
  });

  it('reports a comment that is never closed instead of silently dropping the sections after it', () => {
    const a = readTaskAgreement('## Acceptance\n\n- [A1] x\n\n<!-- never closed\n\n## Non-goals\n\n- [N1] y\n');
    expect(a.problems.map((p) => p.code)).toEqual(expect.arrayContaining(['unterminated-comment', 'non-goals-missing']));
    expect(() => readTaskAgreement('## Acceptance\n\n<!-- never closed\n- [A1] x\n')).not.toThrow();
  });

  it('reads CRLF cards the same as LF cards', () => {
    const lf = ['<!-- old', '## Acceptance', '- [A9] hidden', '-->', ...REAL].join('\n');
    expect(readTaskAgreement(lf.replace(/\n/g, '\r\n'))).toEqual(readTaskAgreement(lf));
  });
});

describe('readTaskAgreement — nested bullets and continuation lines (review round 2)', () => {
  const nested = (indent) => ['## Acceptance', '', '- [A1] parent.', `${indent}- detail`, '- [A2] sibling.', '', '## Non-goals', '', '- [N1] x.'].join('\n');

  it.each([['2 spaces', '  '], ['3 spaces', '   '], ['4 spaces', '    '], ['a tab', '\t']])(
    'folds a sub-bullet indented %s into its parent item instead of inventing an item',
    (_name, indent) => {
      const a = readTaskAgreement(nested(indent));
      expect(a.acceptance).toEqual([{ id: 'A1', text: 'parent. - detail' }, { id: 'A2', text: 'sibling.' }]);
      expect(a.problems).toEqual([]);
    },
  );

  it('keeps a nested bullet that carries its own id as a separate, citable item', () => {
    const a = readTaskAgreement('## Acceptance\n\n- [A1] one\n  - [A2] two\n\n## Non-goals\n\n- [N1] x.\n');
    expect(a.acceptance).toEqual([{ id: 'A1', text: 'one' }, { id: 'A2', text: 'two' }]);
    expect(a.problems).toEqual([]);
  });

  it('keeps siblings that share the first item\'s own indent as separate items', () => {
    const a = readTaskAgreement('## Acceptance\n\n   - [A1] one.\n   - [A2] two.\n\n## Non-goals\n\n- [N1] x.\n');
    expect(a.acceptance.map((i) => i.id)).toEqual(['A1', 'A2']);
  });

  it('keeps an indented continuation after a blank line with its item', () => {
    const a = readTaskAgreement('## Acceptance\n\n- [A1] one.\n\n  more on one.\n- [A2] two.\n\n## Non-goals\n\n- [N1] x.\n');
    expect(a.acceptance).toEqual([{ id: 'A1', text: 'one. more on one.' }, { id: 'A2', text: 'two.' }]);
  });
});

describe('every gate accepts the same heading spellings as the reader (review round 2)', () => {
  const ACCEPTANCE_SPELLINGS = ['Acceptance', 'acceptance', 'Acceptance criteria', 'Acceptance:', 'Done when', 'done when', 'Done when:'];
  const NON_GOALS_SPELLINGS = ['Non-goals', 'Non-goal', 'non-goals', 'Non-goals:'];

  it.each(ACCEPTANCE_SPELLINGS)('reads `## %s` as the acceptance section in the reader, the codex-worker and the orphan sweep', (spelling) => {
    const a = readTaskAgreement(`## ${spelling}\n\n- [A1] it works.\n\n## Non-goals\n\n- [N1] x\n`);
    expect(a.acceptance).toHaveLength(1);
    const card = parseCard(`---\nscope: []\nstatus: open\n---\n# T\n\nDigest.\n\n## ${spelling}\n\n- [A1] it works.\n\n## Non-goals\n\n- [N1] x\n`);
    expect(card.digest).toBe('Digest.');
    expect(card.doneWhen).toContain('- [A1] it works.');
    const head = '---\nstatus: open\nkind: task\n---\n# T\n\nIntro.\n';
    const one = parseOrphanCard('backlog/xaaaaaa-t.md', `${head}\n## ${spelling}\n\n- [A1] one\n`);
    const two = parseOrphanCard('backlog/xaaaaaa-t.md', `${head}\n## ${spelling}\n\n- [A1] two\n`);
    expect(one.digestHash).toBe(two.digestHash);
  });

  it.each(ACCEPTANCE_SPELLINGS)('treats `## %s` as a provenance escape zone', (spelling) => {
    const text = `## ${spelling}\n\n- [A1] \`notYetWritten\` exists.\n`;
    expect(findUnresolvedIdentifiers(text, { resolves: () => false })).toEqual([]);
  });

  it.each(NON_GOALS_SPELLINGS)('reads `## %s` as non-goals in the reader and treats it as a provenance escape zone', (spelling) => {
    expect(readTaskAgreement(`## Acceptance\n\n- [A1] a\n\n## ${spelling}\n\n- [N1] b\n`).nonGoals).toHaveLength(1);
    const text = `## ${spelling}\n\n- [N1] \`neverBuilt\` stays unbuilt.\n`;
    expect(findUnresolvedIdentifiers(text, { resolves: () => false })).toEqual([]);
  });

  it('keeps an unrelated heading out of the escape zone', () => {
    const text = '## Acceptances elsewhere\n\n- `notYetWritten` exists.\n';
    expect(findUnresolvedIdentifiers(text, { resolves: () => false })).not.toEqual([]);
  });
});

describe('the codex-worker and the orphan sweep find the real acceptance section (review round 2)', () => {
  const FRONT = '---\nscope: []\nstatus: open\nkind: task\n---\n# T\n\nDigest.\n\n';

  it('ignore an `## Acceptance` quoted in a fenced example or a commented-out draft', () => {
    const fenced = `${FRONT}\`\`\`md\n## Acceptance\n- [A1] example\n\`\`\`\n\n## Acceptance\n\n- [A1] real.\n\n## Non-goals\n\n- [N1] x\n`;
    expect(parseCard(fenced).doneWhen).toBe('- [A1] real.');
    expect(parseCard(fenced).digest).toContain('example');
    const commented = `${FRONT}<!--\n## Acceptance\n- [A1] old\n-->\n\n## Acceptance\n\n- [A1] real.\n`;
    expect(parseCard(commented).doneWhen).toBe('- [A1] real.');
    const head = '---\nstatus: open\nkind: task\n---\n# T\n\nIntro.\n\n';
    const a = parseOrphanCard('backlog/xaaaaaa-t.md', `${head}\`\`\`md\n## Done when\n\`\`\`\nTail guard text.\n\n## Acceptance\n\n- [A1] one\n`);
    const b = parseOrphanCard('backlog/xaaaaaa-t.md', `${head}\`\`\`md\n## Done when\n\`\`\`\nTail guard text.\n\n## Acceptance\n\n- [A1] two\n`);
    const c = parseOrphanCard('backlog/xaaaaaa-t.md', `${head}\`\`\`md\n## Done when\n\`\`\`\nOther text.\n\n## Acceptance\n\n- [A1] one\n`);
    expect(a.digestHash).toBe(b.digestHash);
    expect(a.digestHash).not.toBe(c.digestHash);
  });

  it('cut a CRLF card at its acceptance heading exactly as an LF card', () => {
    const lf = '---\nstatus: open\nkind: task\n---\n# T\n\nIntro.\n\n## Acceptance\n\n- [A1] one\n';
    const crlf = (s) => s.replace(/\n/g, '\r\n');
    const hash = (s) => parseOrphanCard('backlog/xaaaaaa-t.md', s).digestHash;
    expect(hash(crlf(lf))).toBe(hash(crlf(lf.replace('one', 'two'))));
    expect(parseCard(crlf(lf)).doneWhen).toBe('- [A1] one');
  });

  it('scan a heading line with a long whitespace run in linear time', () => {
    const heading = `## x${' '.repeat(100000)}y\n\n## Acceptance\n\n- [A1] one\n`;
    const started = Date.now();
    expect(parseCard(`# T\n\n${heading}`).doneWhen).toBe('- [A1] one');
    parseOrphanCard('backlog/xaaaaaa-t.md', `---\nstatus: open\n---\n# T\n\n${heading}`);
    readTaskAgreement(heading);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
