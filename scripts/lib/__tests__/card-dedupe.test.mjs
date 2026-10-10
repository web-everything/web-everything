/**
 * @file card-dedupe.test.mjs — dedupe before filing (operator go 2026-10-10). The matcher is pure: a filing's findings
 * against open cards, by target file, defect class and claim similarity. The three behaviours the operator named:
 * a duplicate becomes a mention (no new card), a different file or class is filed, a claimed (active) card is untouched.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveCardDedupePolicy, guardClass, claimSimilarity, claimTokens, parseFilingItems, parseCardItems, cardFromText,
  planDedupe, appendMentions, mentionLine, remainingAfter, filingSource, targetOf, loadCardDedupePolicy, readOpenCards,
  readPrHostedCards, MENTION_HEADING,
} from '../card-dedupe.mjs';

const ON = { dedupe: true, similarity: 0.3 };
const KEY = 'approval-prevention-key:o/r#77@abc123';

const card = ({ id = '4706', status = 'open', items }) => cardFromText({
  rel: `backlog/${id}-prevention-x.md`,
  text: `---\nkind: story\nstatus: ${status}\ndateOpened: "2026-10-03"\n---\n\n# Prevention — x (from o/r#10 review)\n\n`
    + `Filed mechanically ON APPROVAL — this accept verdict named the guard(s) below as owed:\n\n${items.join('\n')}\n\n`
    + `## Design\n\n1. \`we:scripts/other.mjs:1\` — Add a test that is only in the preparer's design.\n`,
});

const filing = (items, { title = 'Prevention — y (from o/r#77 review)' } = {}) => ({
  title, kind: 'story', size: '3', scope: 'we:scripts/lib/a.mjs,we:scripts/lib/__tests__/a.test.mjs,we:scripts/b.mjs',
  parent: '', queue: 'true', session: 's',
  digest: `Filed mechanically ON APPROVAL — this accept verdict named the guard(s) below as owed:\n\n${items.join('\n')}`
    + `\n\nIdempotency key (do not edit): ${KEY}`,
});

const TODO_RULE = '1. `we:backlog/4700-some-card.md:12` — Add a check:standards rule that rejects any backlog card with status open whose Done-when section still contains the literal TODO placeholder.';
const TODO_RULE_AGAIN = '1. `we:backlog/5039-other-card.md:3` — A check:standards rule that refuses to land a backlog card whose Done-when still contains the scaffold TODO placeholder line.';
const PROBE_TEST = '1. `we:scripts/review-ledger-check.mjs:40` — Treat any non-empty probeErrors as unreadable, or have readPrFacts expose a degraded flag. Add a table-driven test over each probe error string.';
const PROBE_TEST_AGAIN = '2. `we:scripts/review-ledger-check.mjs:44` — Make deriveRow treat any non-empty facts.probeErrors as unreadable. Add a table-driven test over every probe error readPrFacts can emit.';

describe('resolveCardDedupePolicy — standard default → platform → repo → env, each key names its source', () => {
  it('is off by default', () => {
    expect(resolveCardDedupePolicy()).toEqual({ dedupe: false, similarity: 0.3, source: { dedupe: 'default', similarity: 'default' } });
  });
  it('a later layer wins, an invalid value falls through', () => {
    const p = resolveCardDedupePolicy({ platform: { dedupe: false, similarity: 0.5 }, repo: { dedupe: true, similarity: 7 }, env: {} });
    expect(p).toMatchObject({ dedupe: true, similarity: 0.5, source: { dedupe: 'repo', similarity: 'platform' } });
    const e = resolveCardDedupePolicy({ repo: { dedupe: true }, env: { WE_CARDS_DEDUPE: '0', WE_CARDS_DEDUPE_SIMILARITY: '0.4' } });
    expect(e).toMatchObject({ dedupe: false, similarity: 0.4, source: { dedupe: 'env', similarity: 'env' } });
  });
  it('a missing platform-preferences file is no preference (the repo override still applies)', () => {
    const read = (p) => {
      if (p.endsWith('card-dedupe.json')) return JSON.stringify({ cards: { dedupe: true, similarity: 0.35 } });
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    expect(loadCardDedupePolicy({ root: '/r', env: {}, read })).toMatchObject({ dedupe: true, similarity: 0.35, source: { dedupe: 'repo' } });
  });
});

describe('classes, targets and similarity — deterministic, no LLM', () => {
  it('the class is the earliest-named guard kind', () => {
    expect(guardClass('Add a check:standards rule and a test')).toBe('standards-rule');
    expect(guardClass('Add a regression test like the lint')).toBe('test');
    expect(guardClass('Refuse a malformed id')).toBe('runtime-guard');
    expect(guardClass('Rename the variable')).toBe('other');
  });
  it('a finding cited on a backlog card targets the card corpus; any other file is its own target', () => {
    expect(targetOf('backlog/4700-x.md')).toBe('backlog/');
    expect(targetOf('scripts/a.mjs')).toBe('scripts/a.mjs');
  });
  it('plural/singular meet, stopwords drop, and reworded asks for the same guard score higher than different guards', () => {
    expect(claimTokens('the rules tests')).toEqual(new Set(['rule', 'test']));
    const same = claimSimilarity(PROBE_TEST, PROBE_TEST_AGAIN);
    const other = claimSimilarity(PROBE_TEST, 'Add a test that the ledger write retries once on a git lock.');
    expect(same).toBeGreaterThan(other);
  });
  it('parses filed findings and mention lines, but not the preparer’s later sections', () => {
    expect(parseFilingItems(filing([PROBE_TEST]).digest)).toHaveLength(1);
    const c = card({ items: [PROBE_TEST] });
    expect(c.items.map((i) => i.file)).toEqual(['scripts/review-ledger-check.mjs']);
    const withMention = appendMentions(c.text, [mentionLine({ source: { repo: 'o/r', pr: 9 }, item: parseFilingItems(PROBE_TEST_AGAIN)[0] })]);
    expect(parseCardItems(withMention)).toHaveLength(2);
  });
  it('filingSource reads the key first', () => {
    expect(filingSource(filing([PROBE_TEST]))).toEqual({ repo: 'o/r', pr: 77 });
  });
});

describe('planDedupe — the three operator behaviours', () => {
  it('a duplicate becomes a mention on the open card, and nothing new is filed', () => {
    const open = [card({ items: [PROBE_TEST] })];
    const plan = planDedupe({ input: filing([PROBE_TEST_AGAIN.replace(/^2\./, '1.')]), cards: open, policy: ON });
    expect(plan.action).toBe('mention');
    expect(plan.remaining).toBeNull();
    expect(plan.mentions).toHaveLength(1);
    expect(plan.mentions[0].card.rel).toBe('backlog/4706-prevention-x.md');
    // The key rides on the mention, so the filer's own on-disk idempotency lookup finds the existing card.
    expect(plan.mentions[0].lines[0]).toMatch(/^- Also raised by o\/r#77 \(finding 1: `we:scripts\/review-ledger-check\.mjs:44` — .+\) · key `approval-prevention-key:o\/r#77@abc123`$/);
  });

  it('the same lint idea raised on a different card is one guard (target = the card corpus)', () => {
    const plan = planDedupe({ input: filing([TODO_RULE_AGAIN]), cards: [card({ items: [TODO_RULE] })], policy: ON });
    expect(plan.action).toBe('mention');
  });

  it('a different target file is filed, even with the identical claim', () => {
    const elsewhere = PROBE_TEST.replace('scripts/review-ledger-check.mjs', 'scripts/other-check.mjs');
    const plan = planDedupe({ input: filing([elsewhere]), cards: [card({ items: [PROBE_TEST] })], policy: ON });
    expect(plan.action).toBe('file');
    expect(plan.mentions).toEqual([]);
  });

  it('a different defect class on the same file is filed', () => {
    const asRule = '1. `we:scripts/review-ledger-check.mjs:40` — Add a check:standards rule that any non-empty probeErrors reads as unreadable in readPrFacts.';
    const plan = planDedupe({ input: filing([asRule]), cards: [card({ items: [PROBE_TEST] })], policy: ON });
    expect(plan.action).toBe('file');
  });

  it('a claimed (active) card is never a target — the finding is filed and the card is untouched', () => {
    const claimed = card({ status: 'active', items: [PROBE_TEST] });
    const before = claimed.text;
    const plan = planDedupe({ input: filing([PROBE_TEST]), cards: [claimed], policy: ON });
    expect(plan.action).toBe('file');
    expect(plan.mentions).toEqual([]);
    expect(claimed.text).toBe(before);
  });

  it('partial: matched findings are mentioned, the rest is filed renumbered, scope trimmed, key kept', () => {
    const other = '2. `we:scripts/b.mjs:5` — Add a test that b refuses an empty list.';
    const plan = planDedupe({ input: filing([PROBE_TEST, other]), cards: [card({ items: [PROBE_TEST] })], policy: ON });
    expect(plan.action).toBe('partial');
    expect(plan.remaining.digest).toContain('1. `we:scripts/b.mjs:5` — Add a test that b refuses an empty list.');
    expect(plan.remaining.digest).not.toContain('probeErrors');
    expect(plan.remaining.digest).toContain('finding 1 → #4706');
    expect(plan.remaining.digest.endsWith(`Idempotency key (do not edit): ${KEY}`)).toBe(true);
    expect(plan.remaining.scope).toBe('we:scripts/b.mjs');
    // The key stays on the NEW card (not on a mention) when something is still filed.
    expect(plan.mentions[0].lines[0]).not.toContain('key');
  });

  it('off → files as today', () => {
    const input = filing([PROBE_TEST]);
    expect(planDedupe({ input, cards: [card({ items: [PROBE_TEST] })], policy: { dedupe: false, similarity: 0.3 } }))
      .toMatchObject({ action: 'off', remaining: input });
  });

  it('remainingAfter files every finding whose mention was not recorded (never dropped)', () => {
    const input = filing([PROBE_TEST]);
    expect(remainingAfter(input, []).digest).toContain('probeErrors');
    expect(remainingAfter(input, [{ item: parseFilingItems(input.digest)[0], card: { id: '1' } }])).toBeNull();
  });
});

describe('appendMentions', () => {
  it('creates the section once, appends to it, and never doubles a line (a retried filing)', () => {
    const c = card({ items: [PROBE_TEST] }).text;
    const once = appendMentions(c, ['- Also raised by o/r#1 (finding 1: `we:a.mjs` — x)']);
    expect(once.split(MENTION_HEADING)).toHaveLength(2);
    expect(appendMentions(once, ['- Also raised by o/r#1 (finding 1: `we:a.mjs` — x)'])).toBe(once);
    const twice = appendMentions(once, ['- Also raised by o/r#2 (finding 1: `we:a.mjs` — y)']);
    expect(twice.split(MENTION_HEADING)).toHaveLength(2);
    expect(twice).toMatch(/o\/r#1 .*\n- Also raised by o\/r#2/);
  });
});

describe('IO readers', () => {
  it('readOpenCards keeps only open cards with filed findings', () => {
    const files = {
      'a.md': card({ id: '1', items: [PROBE_TEST] }).text,
      'b.md': card({ id: '2', status: 'active', items: [PROBE_TEST] }).text,
      'c.md': '---\nstatus: open\n---\n\n# no findings\n',
    };
    const cards = readOpenCards('/l', { list: () => Object.keys(files), read: (p) => files[p.split('/').pop()] });
    expect(cards.map((c) => c.rel)).toEqual(['backlog/a.md']);
  });
  it('readPrHostedCards reads only filing PRs, and a gh failure is no candidates', () => {
    const exec = (cmd, args) => {
      if (args[0] === 'pr') return JSON.stringify([
        { number: 5, headRefName: 'lane/card-batch-prevention-3', files: [{ path: 'backlog/x1-a.md' }] },
        { number: 6, headRefName: 'lane/feature', files: [{ path: 'backlog/x2-b.md' }] },
      ]);
      return card({ id: 'x1abcde', items: [PROBE_TEST] }).text;
    };
    const cards = readPrHostedCards({ exec, cwd: '/l' });
    expect(cards.map((c) => [c.rel, c.host])).toEqual([['backlog/x1-a.md', { pr: 5 }]]);
    expect(readPrHostedCards({ exec: () => { throw new Error('gh down'); }, cwd: '/l' })).toEqual([]);
  });
});

describe('replayDedupe (we:scripts/operations/card-dedupe-replay.mjs) — a past window through the same planner', () => {
  it('counts a later duplicate filing as a mention, and never matches a card already claimed that day', async () => {
    const { replayDedupe } = await import('../../operations/card-dedupe-replay.mjs');
    const mk = (id, opened, item, extra = '') => ({
      rel: `backlog/${id}-p.md`,
      text: `---\nstatus: open\ndateOpened: "${opened}"\n${extra}---\n\n# Prevention — p (from o/r#${id} review)\n\nFiled mechanically ON APPROVAL — owed:\n\n${item}\n`,
    });
    const first = mk('100', '2026-10-03', PROBE_TEST);
    const dup = mk('101', '2026-10-04', PROBE_TEST_AGAIN.replace(/^2\./, '1.'));
    expect(replayDedupe([first, dup], { since: '2026-10-03', until: '2026-10-09', similarity: 0.3 }))
      .toMatchObject({ filings: 2, mentions: 1, filed: 1, mentionedFindings: 1 });
    const claimed = mk('100', '2026-10-03', PROBE_TEST, 'dateStarted: "2026-10-03"\n');
    expect(replayDedupe([claimed, dup], { since: '2026-10-03', until: '2026-10-09', similarity: 0.3 }))
      .toMatchObject({ mentions: 0, filed: 2 });
  });
});
