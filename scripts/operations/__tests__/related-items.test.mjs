/**
 * @file related-items.test.mjs — the read-only `related-items` operation and `file-item`'s related-card check.
 *
 * The fixtures under `../__fixtures__/related-items/backlog/` are REAL cards copied from `we:backlog/` on 2026-10-21
 * (5743, 4015, 4062, 6212, 6231, 4171, 3991, 6852, 1478, 001), so the cases below are the live misses: the
 * orchestrator proposing "shared node_modules across lanes copy-on-write" while 5743 was open, and "red team as a
 * round-1 reviewer" while 6212 was open.
 */
import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RELATED_ITEMS_DEFAULTS, resolveRelatedItemsPolicy, formatRelatedItemsPolicy, compileSynonyms, relatedTokens,
  relatedCardFromText, isEligible, scopeOverlap, normalizeScopePath, rankRelatedItems, planRelatedGate,
  relatedDigestNote, renderRelatedItems,
} from '../../lib/related-items-core.mjs';
import { claimTokens, buildIdf, claimSimilarity } from '../../lib/card-dedupe.mjs';
import * as shared from '../../lib/claim-similarity.mjs';
import { readRelatedCards, loadRelatedItemsPolicy, createRelatedItemsReader } from '../related-items-io.mjs';
import { relatedItemsOperation, RELATED_ITEMS_OP, assessRelatedItems, finishRelatedItems } from '../related-items.mjs';
import { fileItemOperation, FILE_ITEM_OP, planRelatedCheck, finishFileItem, planFileItem } from '../file-item.mjs';
import { shapeScaffoldRead, SCAFFOLD_EFFECT } from '../scaffold.mjs';
import { FILE_ITEM_QUEUE_EFFECT } from '../file-item.mjs';
import { advanceWhileRunning, startRun, runStatus } from '../engine.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { createRegistry, isReadOnlyOperation } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_BACKLOG = join(HERE, '..', '__fixtures__', 'related-items', 'backlog');
const TODAY = '2026-10-21';
const policy = (over = {}) => resolveRelatedItemsPolicy({ repo: over });
const { cards } = readRelatedCards(FIXTURE_BACKLOG);
const rank = (text, over = {}, q = {}) => rankRelatedItems({ query: { text, ...q }, cards, policy: policy(over), today: TODAY });

describe('the shared matcher', () => {
  it('card-dedupe re-exports the very same functions it moved to claim-similarity.mjs', () => {
    expect(claimTokens).toBe(shared.claimTokens);
    expect(buildIdf).toBe(shared.buildIdf);
    expect(claimSimilarity).toBe(shared.claimSimilarity);
  });
});

describe('policy cascade', () => {
  it('default → platform → repo → env, each key naming its source; a typo falls through', () => {
    const p = resolveRelatedItemsPolicy({
      platform: { threshold: 0.4, fileItem: 'refuse' },
      repo: { threshold: 0.6, fileItem: 'bogus', statuses: [] },
      env: {},
    });
    expect(p.threshold).toBe(0.6);
    expect(p.source.threshold).toBe('repo');
    expect(p.fileItem).toBe('refuse');
    expect(p.source.fileItem).toBe('platform');
    expect(p.statuses).toEqual(RELATED_ITEMS_DEFAULTS.statuses);
    expect(p.source.statuses).toBe('default');
    const e = resolveRelatedItemsPolicy({ repo: { enabled: true }, env: { WE_RELATED_ITEMS: 'off', WE_RELATED_ITEMS_FILE_ITEM: 'warn', WE_RELATED_ITEMS_THRESHOLD: '0.7' } });
    expect([e.enabled, e.source.enabled, e.fileItem, e.source.fileItem, e.threshold, e.source.threshold]).toEqual([false, 'env', 'warn', 'env', 0.7, 'env']);
    expect(formatRelatedItemsPolicy(e)).toMatch(/enabled=false \(env\).*fileItem=warn \(env\).*threshold=0\.7 \(env\)/);
  });

  it('the repo settings file is read through the cascade (warn-only for file-item, on for related-items)', () => {
    const p = loadRelatedItemsPolicy({ env: {} });
    expect(p.enabled).toBe(true);
    expect(p.fileItem).toBe('warn');
    expect(p.source.fileItem).toBe('repo');
  });
});

describe('tokens, cards, eligibility, scope', () => {
  it('folds synonym groups: node_modules / npm ci / pnpm meet; red team / red-team / redteam meet', () => {
    const syn = compileSynonyms(RELATED_ITEMS_DEFAULTS.synonyms);
    const a = relatedTokens('shared node_modules', syn);
    const b = relatedTokens('pnpm instead of npm ci copies', syn);
    expect([...a].some((t) => b.has(t))).toBe(true);
    expect(relatedTokens('red team', syn)).toEqual(relatedTokens('redTeam', syn));
    expect(relatedTokens('red-team', syn)).toEqual(relatedTokens('redteam', syn));
    // `npm` never matches inside `pnpm` — both fold to the same group anyway, but no partial rewrite.
    expect(syn.fold('pnpm')).not.toMatch(/ppnpm/);
  });

  it('parses a real card: id, status, scope, title, lead', () => {
    const c = cards.find((x) => x.id === '5743');
    expect(c.status).toBe('open');
    expect(c.scope).toContain('we:scripts/lane-pool.mjs');
    expect(c.title).toMatch(/^Installs use pnpm/);
    expect(c.lead).toMatch(/^Held item 205/);
  });

  it('eligible: open/parked/active, and resolved only inside the window', () => {
    const p = policy();
    const recent = cards.find((x) => x.id === '3991'); // resolved 2026-09-23
    const old = cards.find((x) => x.id === '001'); // resolved 2026-06-06
    expect(isEligible(recent, p, TODAY)).toBe(true);
    expect(isEligible(old, p, TODAY)).toBe(false);
    expect(isEligible(recent, policy({ resolvedWithinDays: 7 }), TODAY)).toBe(false);
    expect(isEligible(cards.find((x) => x.status === 'parked'), p, TODAY)).toBe(true);
  });

  it('scope overlap is by path prefix, either direction, bare paths read as we:', () => {
    expect(normalizeScopePath('scripts/lane-pool.mjs:12')).toBe('we:scripts/lane-pool.mjs');
    expect(scopeOverlap('we:scripts/lib/daemon-rebuild/x.mjs,we:other.mjs', ['we:scripts/lib/daemon-rebuild/']))
      .toEqual({ score: 0.5, matched: ['we:scripts/lib/daemon-rebuild/x.mjs'] });
    expect(scopeOverlap('we:scripts/', ['we:scripts/lane-pool.mjs']).score).toBe(1);
    expect(scopeOverlap('we:scripts-other', ['we:scripts']).score).toBe(0);
  });
});

describe('ranking on real cards', () => {
  it('finds 5743 first for the live miss "shared node_modules across lanes", and says why', () => {
    const r = rank('shared node_modules across lanes');
    expect(r.matches[0].id).toBe('5743');
    expect(r.matches[0].score).toBeGreaterThanOrEqual(r.threshold);
    expect(r.matches[0].why.terms.join(' ')).toMatch(/node_modules/);
  });

  it('"… copy-on-write" puts 5743 and the copy-on-write node_modules lane card 4015 in the top two, both over threshold', () => {
    const r = rank('shared node_modules across lanes copy-on-write');
    const top = r.matches.slice(0, 2);
    expect(top.map((m) => m.id).sort()).toEqual(['4015', '5743']);
    for (const m of top) expect(m.score).toBeGreaterThanOrEqual(r.threshold);
  });

  it('finds 6212 above threshold for "red team as a round-1 reviewer"', () => {
    const r = rank('red team as a round-1 reviewer');
    const hit = r.matches.find((m) => m.id === '6212');
    expect(hit).toBeTruthy();
    expect(hit.score).toBeGreaterThanOrEqual(r.threshold);
    expect(hit.why.terms.join(' ')).toMatch(/redteam/);
  });

  it('a tests-hang idea ranks the hung-run card above unrelated ones', () => {
    const r = rank('fix tests that hang on main');
    expect(r.matches[0].id).toBe('4171');
  });

  it('scope and tags add to the score, and the why names the paths', () => {
    const plain = rank('installs').matches.find((m) => m.id === '5743');
    const scoped = rank('installs', {}, { scope: 'we:scripts/lib/daemon-rebuild/' }).matches.find((m) => m.id === '5743');
    expect(scoped.score).toBeGreaterThan(plain.score);
    expect(scoped.why.paths).toEqual(['we:scripts/lib/daemon-rebuild']);
  });

  it('an unrelated idea scores below threshold everywhere', () => {
    const r = rank('brand mark favicon gradient for the marketing site');
    expect(r.aboveThreshold).toBe(0);
  });

  it('excludes a card by id, and honours --limit', () => {
    const r = rank('shared node_modules across lanes', {}, { exclude: '#5743', limit: 2 });
    expect(r.matches.map((m) => m.id)).not.toContain('5743');
    expect(r.matches.length).toBeLessThanOrEqual(2);
  });

  it('renders one line per match plus its why', () => {
    const lines = renderRelatedItems(rank('shared node_modules across lanes'), { policyLine: 'p' });
    expect(lines[0]).toMatch(/^related-items: \d+ match/);
    expect(lines.some((l) => /#5743 \(open\) Installs use pnpm/.test(l))).toBe(true);
    expect(lines.at(-1)).toBe('policy: p');
  });
});

describe('the related-items declaration', () => {
  const ctx = () => ({ cards, policy: policy(), today: TODAY, unreadable: 0 });

  it('is read-only: one compute step, no sinks needed', () => {
    const decl = relatedItemsOperation({ readContext: ctx });
    expect(decl.name).toBe(RELATED_ITEMS_OP);
    expect(isReadOnlyOperation(decl)).toBe(true);
  });

  it('runs end to end and its verdict carries the ranked matches', () => {
    const registry = createRegistry();
    registry.register(relatedItemsOperation({ readContext: ctx }));
    const run = advanceWhileRunning(startRun({ op: RELATED_ITEMS_OP, id: 'ri-1', input: { text: 'shared node_modules across lanes' }, registry }), { registry });
    expect(run.verdict.matches[0].id).toBe('5743');
    const { lines } = finishRelatedItems({ run, code: 0, lines: ['x'] });
    expect(lines.join('\n')).toMatch(/#5743/);
    expect(finishRelatedItems({ run, code: 0, lines: ['x'], json: true }).lines).toEqual(['x']);
  });

  it('the kill switch turns it off; an empty --text is refused', () => {
    expect(assessRelatedItems({ ...ctx(), policy: policy({ enabled: false }) }, { text: 'x' }).disabled).toBe(true);
    expect(() => assessRelatedItems(ctx(), { text: '  ' })).toThrow(/--text/);
  });

  it('the real IO reader reads the fixture corpus', () => {
    const c = createRelatedItemsReader({ backlogDir: FIXTURE_BACKLOG, env: {}, today: () => TODAY })();
    expect(c.cards).toHaveLength(10);
    expect(c.today).toBe(TODAY);
    expect(c.policy.fileItem).toBe('warn');
  });
});

describe('file-item related-card gate', () => {
  // The live 2026-10-21 proposal, as a filing would carry it.
  const filing = { title: 'Shared node_modules via copy-on-write', digest: 'Lanes each run npm ci into their own node_modules; share one copy across lanes with copy-on-write.' };
  const ctx = (over = {}) => ({ cards, policy: policy(over), today: TODAY });

  it('warn mode (the default) lists the match but never refuses', () => {
    const g = planRelatedCheck(ctx(), filing);
    expect(g.mode).toBe('warn');
    expect(g.above).toContain('5743');
    expect(g.refuse).toBe(false);
    expect(g.lines.join('\n')).toMatch(/warn-only.*--related=<id>/s);
    expect(g.lines.at(-1)).toMatch(/^policy: relatedItems\.enabled=true/);
  });

  it('refuse mode refuses an unnamed filing, and lets it through once it names the card or says why it is new', () => {
    expect(planRelatedCheck(ctx({ fileItem: 'refuse' }), filing).refuse).toBe(true);
    expect(planRelatedCheck(ctx({ fileItem: 'refuse' }), { ...filing, related: '5743' }).refuse).toBe(false);
    expect(planRelatedCheck(ctx({ fileItem: 'refuse' }), { ...filing, parent: '#5743' }).refuse).toBe(false);
    expect(planRelatedCheck(ctx({ fileItem: 'refuse' }), { ...filing, 'new-because': 'covers CI runners, not lanes' }).refuse).toBe(false);
    // naming an unrelated card does not satisfy it
    expect(planRelatedCheck(ctx({ fileItem: 'refuse' }), { ...filing, related: '1478' }).refuse).toBe(true);
  });

  it('off mode, the kill switch, no reader, and a reader error never check and never refuse', () => {
    for (const g of [planRelatedCheck(ctx({ fileItem: 'off' }), filing), planRelatedCheck(ctx({ enabled: false, fileItem: 'refuse' }), filing),
      planRelatedCheck(null, filing), planRelatedCheck({ error: 'boom' }, filing)]) {
      expect(g.refuse).toBe(false);
      expect(g.checked).toBe(false);
    }
  });

  it('audit fixes: an empty-message reader error fails open; naming any over-threshold card satisfies even past --limit; 001 ≡ 1; floor never hides a qualifying card', () => {
    const g = planRelatedCheck({ error: '' }, filing);
    expect(g.refuse).toBe(false);
    expect(g.checked).toBe(false);
    const both = rankRelatedItems({ query: { text: 'shared node_modules across lanes copy-on-write', limit: 1 }, cards, policy: policy(), today: TODAY });
    expect(both.matches).toHaveLength(1);
    const second = both.aboveIds.find((id) => id !== both.matches[0].id);
    expect(second).toBeTruthy();
    expect(planRelatedGate({ result: both, policy: policy({ fileItem: 'refuse' }), input: { related: second } }).refuse).toBe(false);
    const zeroPadded = { ...both, aboveIds: ['001'] };
    expect(planRelatedGate({ result: zeroPadded, policy: policy({ fileItem: 'refuse' }), input: { parent: '1' } }).refuse).toBe(false);
    const highFloor = rank('shared node_modules across lanes', { floor: 0.95 });
    expect(highFloor.aboveThreshold).toBeGreaterThan(0);
    expect(highFloor.matches.length).toBeGreaterThan(0);
    expect(formatRelatedItemsPolicy(policy())).toMatch(/floor=.*limit=.*queryTerms=.*weights=text:/);
    // past the display cap: 201 qualifying cards, naming the 201st still satisfies the gate
    // (copies of 5743 inside the real fixture corpus, so IDF still separates them from the rest)
    const many = [...cards, ...Array.from({ length: 201 }, (_, i) => ({ ...cards.find((c) => c.id === '5743'), id: String(7000 + i), rel: `backlog/${7000 + i}-x.md` }))];
    const strict = policy({ fileItem: 'refuse', threshold: 0.2 });
    const ranked = rankRelatedItems({ query: { text: `${filing.title}\n${filing.digest}` }, cards: many, policy: strict, today: TODAY });
    expect(ranked.aboveThreshold).toBeGreaterThanOrEqual(202);
    expect(ranked.aboveIds).toHaveLength(200);
    expect(ranked.aboveIds).not.toContain('7200');
    const g201 = planRelatedCheck({ cards: many, policy: strict, today: TODAY }, { ...filing, related: '7200' });
    expect(g201.refuse).toBe(false);
    expect(planRelatedCheck({ cards: many, policy: strict, today: TODAY }, filing).refuse).toBe(true);
  });

  it('an unrelated filing produces no lines even in refuse mode', () => {
    const g = planRelatedCheck(ctx({ fileItem: 'refuse' }), { title: 'Brand mark favicon gradient', digest: 'marketing site logo' });
    expect(g.above).toEqual([]);
    expect(g.refuse).toBe(false);
    expect(g.lines).toEqual([]);
  });

  it('records --related / --new-because under the digest', () => {
    expect(relatedDigestNote({ related: '5743,#4015', newBecause: 'covers CI' })).toBe('Related: #5743, #4015. New because: covers CI');
    const read = shapeScaffoldRead({ existingIds: ['001'], today: TODAY, dir: '/repo/backlog' });
    const { content } = planFileItem(read, { title: 't', workItem: 'task', digest: 'why', related: '5743' });
    expect(content).toMatch(/why\n\nRelated: #5743\./);
    const plain = planFileItem(read, { title: 't', workItem: 'task', digest: 'why' });
    expect(plain.content).not.toMatch(/Related:/);
  });

  async function drive(over, input) {
    const registry = createRegistry();
    registry.register(fileItemOperation({
      readScaffoldContext: () => ({ existingIds: ['001'], today: TODAY, dir: '/repo/backlog' }),
      readRelated: () => ctx(over),
    }));
    const written = [];
    const sinks = {
      [SCAFFOLD_EFFECT]: async (p) => { written.push(p); return { rel: p.rel, written: true }; },
      [FILE_ITEM_QUEUE_EFFECT]: async (p) => ({ num: p.num, queued: true }),
    };
    let run;
    try {
      run = advanceWhileRunning(startRun({ op: FILE_ITEM_OP, id: `fi-${Math.random()}`, input: { workItem: 'task', queue: 'false', ...input }, registry }), { registry });
    } catch (e) {
      return { error: e, written };
    }
    for (let i = 0; i < 10 && runStatus(run, { registry }) === 'awaiting-effect'; i += 1) {
      run = (await applyPendingEffects(run, { registry, sinks, store: createMemoryRunStore() })).run;
      run = advanceWhileRunning(run, { registry });
    }
    return { run, written };
  }

  it('end to end: warn files the card and the CLI trailer prints the match', async () => {
    const { run, written } = await drive({}, filing);
    expect(written).toHaveLength(1);
    expect(run.findings.related.above).toContain('5743');
    const { lines } = finishFileItem({ run, code: 0, lines: ['run x — complete.'] });
    expect(lines.join('\n')).toMatch(/#5743 \(open\) Installs use pnpm/);
  });

  it('end to end: refuse writes nothing and the refusal lists the match', async () => {
    const out = await drive({ fileItem: 'refuse' }, filing);
    expect(out.written).toHaveLength(0);
    const text = out.error ? String(out.error.message) : JSON.stringify(out.run);
    expect(text).toMatch(/REFUSED/);
    expect(text).toMatch(/5743/);
  });

  it('end to end: refuse + --new-because (the CLI spelling) files the card with the reason', async () => {
    const { written } = await drive({ fileItem: 'refuse' }, { ...filing, 'new-because': 'covers CI runners, not lanes' });
    expect(written).toHaveLength(1);
    expect(written[0].content).toMatch(/New because: covers CI runners, not lanes/);
  });

  it('end to end: refuse + --related files the card with the note', async () => {
    const { written } = await drive({ fileItem: 'refuse' }, { ...filing, related: '5743' });
    expect(written).toHaveLength(1);
    expect(written[0].content).toMatch(/Related: #5743\./);
  });
});
