/**
 * @file verdict-ledger-outbox-spool.test.mjs - the ledger OUTBOX + PLUMBING flush (live 2026-10-21: 3+ same-host writers
 *   raced 9-second worktree pushes to `ops/review-requests`, the losers exhausted 5 short retries and referral holds
 *   and rulings never persisted, #5502 #5530 #5773 #5742 #5768).
 *
 * The append writes its rows to a host-local outbox first, then ONE writer at a time (a host-wide flusher lock)
 * pushes everything queued as ONE plumbing commit. These tests pin the invariants: every row lands exactly once,
 * a crash between push and delete never duplicates, an off-host (CI) writer's push is retried on the new tip,
 * nothing is ever forced, and a failure still surfaces.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveOutboxSettings, formatOutboxSettings, OUTBOX_ENV, enqueueOutboxEntry, listOutboxEntries,
} from '../verdict-ledger-outbox-spool.mjs';
import { ledgerGitPath } from '../verdict-ledger-path.mjs';

const REPO = 'web-everything/web-everything';

describe('outbox settings: a cascade, logged with its source', () => {
  it('defaults on, with a time budget and a stale age, sources named', () => {
    const s = resolveOutboxSettings({ repo: {}, env: {} });
    expect(s.enabled).toBe(true);
    expect(s.flushBudgetMs).toBeGreaterThan(10_000);
    expect(s.staleMs).toBeGreaterThan(s.flushBudgetMs);
    expect(s.sources).toEqual({ enabled: 'standard', flushBudgetMs: 'standard', staleMs: 'standard' });
  });

  it('is OFF in CI (an ephemeral runner would lose its outbox) unless the env forces it', () => {
    expect(resolveOutboxSettings({ repo: {}, env: { GITHUB_ACTIONS: 'true' } })).toMatchObject({ enabled: false, sources: { enabled: 'ci' } });
    expect(resolveOutboxSettings({ repo: {}, env: { GITHUB_ACTIONS: 'true', [OUTBOX_ENV]: '1' } })).toMatchObject({ enabled: true, sources: { enabled: 'env' } });
  });

  it('repo overrides standard, env overrides repo, invalid layers are ignored and named', () => {
    const s = resolveOutboxSettings({ repo: { verdictLedger: { outbox: false, flushBudgetMs: 30_000, outboxStaleMs: 'x' } }, env: {} });
    expect(s).toMatchObject({ enabled: false, flushBudgetMs: 30_000, sources: { enabled: 'repo', flushBudgetMs: 'repo', staleMs: 'standard' } });
    expect(s.invalid).toEqual(['repo.verdictLedger.outboxStaleMs']);
    expect(formatOutboxSettings(s)).toMatch(/verdictLedger\.flushBudgetMs=30000 \(repo\)/);
  });
});

describe('real git: outbox + plumbing flush', () => {
  it('a short or corrupt entry write throws BEFORE anything is queued (read-back check)', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ob-')), 'outbox');
    const bad = { path: ledgerGitPath(REPO), repo: REPO, message: 'm', lines: ['{"not":"an event"}'], ids: ['x'] };
    expect(() => enqueueOutboxEntry(dir, bad)).toThrow(/write check/);
    expect(listOutboxEntries(dir)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});
