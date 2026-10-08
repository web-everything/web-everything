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
