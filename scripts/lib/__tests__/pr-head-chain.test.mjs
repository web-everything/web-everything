import { describe, it, expect } from 'vitest';
import { buildLedgerEvent, validateLedgerEvent, parseLedgerEvents, serializeLedgerEvent, eventBears } from '../verdict-ledger.mjs';
import { derivePrState } from '../pr-state.mjs';

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
const fields = { headSha: HEAD, parentSha: null, baseSha: BASE, headRef: 'lane/fixture', baseRef: 'main',
  commits: { count: 1, substantive: 1, ai: 1, nonAi: [], digest: `sha256:${'c'.repeat(64)}` }, authorship: 'ai' };
const row = (over = {}) => buildLedgerEvent({ type: 'author', repo: 'web-everything/web-everything', pr: 1,
  at: '2026-11-27T22:00:00.000Z', source: 'pr-land', writer: 'fixture', author: 'fixture', ...fields, ...over });
describe('PR-HEAD-CHAIN-RECORD', () => {
  it('PR-HEAD-CHAIN-RECORD: author head row round-trips without bearing on the actual ledger fold', () => {
    const r = row();
    expect(r).toMatchObject(fields);
    expect(parseLedgerEvents(serializeLedgerEvent(r).line)).toEqual([r]);
    expect(eventBears('author')).toBe(false);
    const facts = { repo: r.repo, pr: 1, headSha: HEAD };
    expect(derivePrState([r], facts)).toEqual(derivePrState([], facts));
    expect(validateLedgerEvent(row({ ...Object.fromEntries(Object.keys(fields).map(k => [k, undefined])) })).valid).toBe(true);
  });
  it.each([
    { baseSha: 'bad' }, { headSha: HEAD.slice(1) }, { parentSha: 'bad' }, { headRef: '../bad' }, { baseRef: '' },
    { baseSha: undefined }, { parentSha: undefined }, { authorship: 'human' },
    { commits: { ...fields.commits, digest: 'bad' } },
    { commits: { ...fields.commits, nonAi: Array(21).fill(HEAD) } },
    { commits: { ...fields.commits, count: 0 } },
    { commits: { ...fields.commits, substantive: 2 } },
  ])('author head row refuses contradictory, malformed or partial facts: %j', over => {
    expect(validateLedgerEvent({ ...row(), ...over }).valid).toBe(false);
  });
  it('PR-HEAD-CHAIN-RECORD: reader trusts only a row bound to the live head', async () => {
    const { indexPrHeads, lookupPrHead } = await import('../pr-head-chain.mjs');
    const index = indexPrHeads([row()]);
    const live = { repo: 'chalbert/web-everything', pr: 1, headSha: HEAD, baseSha: BASE, headRef: 'lane/fixture', baseRef: 'main' };
    expect(lookupPrHead(index, live)?.authorship).toBe('ai');
    for (const key of ['headSha', 'baseSha', 'headRef', 'baseRef']) expect(lookupPrHead(index, { ...live, [key]: 'different' })).toBeNull();
    expect(lookupPrHead(indexPrHeads([row({ source: 'forged' })]), live)).toBeNull();
    expect(lookupPrHead(indexPrHeads([row(), row({ at: '2026-11-26T22:00:00.000Z', authorship: 'human',
      commits: { ...fields.commits, ai: 0, nonAi: [HEAD] } })]), live)?.authorship).toBe('human');
  });
  it('PR-HEAD-CHAIN-RECORD: loader fails closed on a later malformed human author row', async () => {
    const { indexPrHeads, loadHeadChainIndex, lookupPrHead } = await import('../pr-head-chain.mjs');
    const positive = row();
    const invalidHuman = { ...positive, authorship: 'human' };
    const live = { repo: positive.repo, pr: 1, ...fields };
    const alerts = [];
    const load = rows => {
      const text = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
      return loadHeadChainIndex(positive.repo, { path: 'fixture-ledger.jsonl',
        stat: () => ({ size: Buffer.byteLength(text) }), read: () => text,
        alert: entry => alerts.push(entry) });
    };
    expect(validateLedgerEvent(invalidHuman).valid).toBe(false);
    expect(lookupPrHead(load([positive]), live)?.authorship).toBe('ai');
    expect(lookupPrHead(indexPrHeads([positive, invalidHuman]), live)).toBeNull();
    expect(lookupPrHead(load([positive, invalidHuman]), live)).toBeNull();
    expect(alerts).toEqual([]);
  });
});
