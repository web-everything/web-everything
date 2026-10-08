/**
 * @file verdict-ledger-store.test.mjs - card xsij7u6: the store contract, the registry, and the conformance suite
 *   run against both built-in adapters (home file, git branch).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLedgerStoreConformance } from './verdict-ledger-store-conformance.mjs';
import {
  validateLedgerStore, registerLedgerStore, getLedgerStore, ledgerStoreNames,
} from '../verdict-ledger-store.mjs';
import {
  homeLedgerStore, verdictLedgerPath, appendVerdict, resolveLedgerStoreChoice, buildVerdictRecord, readVerdictLedger,
} from '../verdict-ledger.mjs';
import { LEDGER_TRANSPORT_BRANCH } from '../verdict-ledger-io.mjs';
import { withBareOrigin, git } from '../../operations/__tests__/helpers/real-repo.mjs';

const REPO = 'web-everything/web-everything';
const noSleep = () => {};

const homeHarness = async (use) => {
  const dir = mkdtempSync(join(tmpdir(), 'we-ledger-store-home-'));
  const prev = process.env.WE_VERDICT_LEDGER_DIR;
  process.env.WE_VERDICT_LEDGER_DIR = dir;
  try {
    await use({
      store: getLedgerStore('home'), appendCtx: {}, readCtx: {}, repo: REPO,
      // A directory where the ledger file should be: reads and appends both fail with EISDIR.
      breakStore: () => { rmSync(verdictLedgerPath(REPO), { force: true }); mkdirSync(verdictLedgerPath(REPO), { recursive: true }); },
    });
  } finally {
    if (prev === undefined) delete process.env.WE_VERDICT_LEDGER_DIR; else process.env.WE_VERDICT_LEDGER_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
};

const gitHarness = async (use) => {
  await withBareOrigin(async (ctx) => {
    ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
    await use({
      store: getLedgerStore('git'),
      appendCtx: { board: ctx.clone, attempts: 2, sleep: noSleep },
      readCtx: { board: ctx.clone },
      repo: REPO,
      breakStore: () => git(['remote', 'set-url', 'origin', join(ctx.tmp, 'does-not-exist.git')], { cwd: ctx.clone }),
    });
  });
};

runLedgerStoreConformance('home', homeHarness);
runLedgerStoreConformance('git', gitHarness);

describe('capabilities differ as declared', () => {
  it('home is local, git is shared with a total order', () => {
    expect(getLedgerStore('home').capabilities).toEqual({ durable: true, shared: false, ordering: 'append' });
    expect(getLedgerStore('git').capabilities).toEqual({ durable: true, shared: true, ordering: 'total' });
  });
});

describe('registry', () => {
  const names = [];
  afterEach(() => { delete process.env.WE_VERDICT_LEDGER_DIR; });

  it('registers home and git by name', () => {
    expect(ledgerStoreNames()).toEqual(expect.arrayContaining(['home', 'git']));
    expect(getLedgerStore('home')).toBe(homeLedgerStore);
    expect(getLedgerStore('nope')).toBeNull();
  });

  it('refuses a store that breaks the contract', () => {
    expect(validateLedgerStore({ name: 'x' }).ok).toBe(false);
    expect(() => registerLedgerStore({ name: 'Bad Name', append() {}, read() {}, capabilities: { durable: true, shared: true, ordering: 'total' } })).toThrow(/invalid store/);
    expect(() => registerLedgerStore({ name: 'x', append() {}, read() {}, capabilities: { durable: true, shared: true, ordering: 'sideways' } })).toThrow(/ordering/);
  });

  it('a plugged store is selectable by name through verdictLedger.store with no caller change', () => {
    const rows = [];
    names.push('fake-product');
    registerLedgerStore({
      name: 'fake-product',
      capabilities: { durable: true, shared: true, ordering: 'total' },
      append: (r) => { rows.push(...r); return { ok: true, appended: r.length }; },
      read: () => ({ status: 'ok', rows }),
    });
    expect(resolveLedgerStoreChoice('fake-product', {})).toEqual({ store: 'fake-product', named: true });
    const rec = buildVerdictRecord({ repo: REPO, pr: 9, verdict: 'accepted', at: '2026-10-07T12:00:00.000Z', source: 'test' });
    const r = appendVerdict(rec, { store: 'fake-product', env: {} });
    expect(r).toMatchObject({ ok: true, store: 'fake-product' });
    expect(rows).toHaveLength(1);
  });

  it('a plugged store that misses follows the F4 posture: a clearing verdict does not clear', () => {
    registerLedgerStore({
      name: 'down-product',
      capabilities: { durable: true, shared: true, ordering: 'total' },
      append: () => ({ ok: false, appended: 0, error: 'unreachable' }),
      read: () => ({ status: 'unreadable', reason: 'down', error: 'unreachable' }),
    });
    const rec = buildVerdictRecord({ repo: REPO, pr: 9, verdict: 'accepted', at: '2026-10-07T12:00:00.000Z', source: 'test' });
    const r = appendVerdict(rec, { store: 'down-product', env: {}, warn: () => {} });
    expect(r).toMatchObject({ ok: false, ledgerWriteMiss: true });
    expect(readVerdictLedger(REPO).some((x) => x.pr === 9)).toBe(false);
  });
});
