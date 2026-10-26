import { describe, it, expect, vi } from 'vitest';
import { buildPrTrace, finishPrTrace, prTraceOperation } from '../pr-trace.mjs';
import { createPrTraceReader } from '../pr-trace-io.mjs';
import { createRegistry, isReadOnlyOperation } from '../registry.mjs';
import { runOperationCli } from '../cli-adapter.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { resolveOperation } from '../run.mjs';
import { FIXTURE_SLUG, withRealRepo } from './helpers/real-repo.mjs';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const repo = 'owner/repo', head = 'a'.repeat(40), old = 'b'.repeat(40);
const now = Date.parse('2026-10-26T16:00:00Z');
const live = { headRefOid: head, labels: [], reviews: [], statusCheckRollup: [], mergeQueueEntry: null };
const trace = (pr, patch = {}) => buildPrTrace({ pr, repo, now, live, sources: {}, ...patch });
const drain = (pr, reason) => `merge-ai-prs · skip-reasons: ${JSON.stringify([{ num: pr, repo, reason }])}`;
describe('pr-trace observed blockers', () => {
  it('#5912 draft waiting on a CI shard is not a deadlock', () => {
    const out = trace(5912, { live: { ...live, isDraft: true, statusCheckRollup: [
      { name: 'test shard 3', status: 'IN_PROGRESS', startedAt: '2026-10-26T15:30:00Z' }] } });
    expect(out.likelyBlocker).toContain('waiting on CI shard test shard 3');
    expect(out.likelyBlocker).not.toMatch(/deadlock/);
    expect(out.ci[0].ageMinutes).toBe(30);
  });
  it('#5929 names the stored red-team head mismatch', () => {
    expect(trace(5929, { sources: { 'red-team-status': JSON.stringify({ repo, pr: 5929, head: old, status: 'finished' }) } }).likelyBlocker)
      .toContain('stored red-team head != live head');
  });
  it('#5874 names the landing holder', () => {
    expect(trace(5874, { sources: { drain: drain(5874, 'merge-queue: wait (behind landing holder #5870)') } }).likelyBlocker).toBe('#5874 waiting behind landing holder #5870');
  });
  it('#5878 reports a live pid on a stuck session', () => {
    const out = trace(5878, { sources: { fix: 'reconcile-fix-dispatch-daemon: refused live-process owner/repo PR #5878 — pid 123 alive, session stalled [name=fix-5878 cwd=fixture]' } });
    expect(out.likelyBlocker).toMatch(/^#5878 live pid on stuck session/);
    expect(trace(5878, { sources: { fix: 'PR #5878 pid 123 alive, making progress' } }).likelyBlocker).not.toContain('stuck session');
  });
  it('detects repeated reasons across timestamps, scoped to the exact PR', () => {
    const logs = Array.from({ length: 10 }, (_, n) => `2026-10-26T15:${String(n).padStart(2, '0')}:00Z PR #12 waiting for review`).join('\n');
    const out = trace(12, { sources: { review: logs + '\nPR #123 wrong PR' } });
    expect(out.looping[0]).toMatchObject({ count: 10 });
    expect(out.latest.review).toContain('waiting for review');
  });
  it('reports label conflicts and sanitizes terminal controls', () => {
    const out = trace(12, { live: { ...live, labels: [{ name: 'review:accepted' }, { name: 'review:pending' }] }, sources: { fix: 'PR #12 \u001b[31mreason' } });
    expect(out.conflicts).toContain('review:accepted + review:pending');
    expect(finishPrTrace({ run: { verdict: out }, code: 0, json: false }).lines.join('')).not.toContain('\u001b');
  });
  it('degrades gracefully with unavailable sources and unknown GitHub evidence', () => {
    const read = createPrTraceReader({ gh: () => { throw Error('offline'); }, paths: () => ({ review: null }), readStatuses: () => '', now: () => now });
    const out = buildPrTrace(read({ pr: 12, repo }));
    expect(out.unavailable).toContain('github');
    expect(out.unavailable).toContain('review');
    expect(out.likelyBlocker).toContain('inspect unavailable evidence');
  });
  it('reads bounded fixtures, filters repositories, and preserves JSON facts', () => {
    const gh = vi.fn(() => JSON.stringify(live));
    const read = createPrTraceReader({ gh, paths: () => ({ review: 'fixture' }), readStatuses: () => '', tail: () => ({ text: 'PR #12 waiting', truncated: true }), now: () => now });
    const out = buildPrTrace(read({ pr: 12, repo }));
    expect(out.incomplete).toContain('review: bounded tail; inspect full source if needed');
    expect(gh).toHaveBeenCalledTimes(2);
    expect(trace(12, { sources: { 'daemon-events': JSON.stringify({ repo: 'other/repo', pr: 12, detail: 'wrong' }) } }).latest['daemon-events']).toBeUndefined();
    expect(JSON.parse(finishPrTrace({ run: { verdict: out }, code: 0, json: true }).lines[0])).toEqual(out);
  });
  it('chains stored review mismatch to observed drain renumber with ET time', () => {
    const out = trace(12, { live: { ...live, labels: ['red-team:pending'] }, sources: {
      'review-ledger': JSON.stringify({ repo, pr: 12, coverage: { headSha: old } }),
      drain: '2026-10-26T15:00:00Z PR #12 drain renumber' } });
    expect(out.likelyBlocker).toMatch(/red-team publish <- stored review head != live head <- drain renumber at .*11:00:00 AM EDT/);
  });
  it('reports malformed evidence and does not infer a clear outcome', () => {
    const out = trace(12, { sources: { 'daemon-events': '{broken' } });
    expect(out.incomplete[0]).toContain('malformed JSON');
    expect(out.likelyBlocker).toContain('inspect unavailable evidence');
  });
  it('keeps large JSON intact and control sequences inert', () => {
    const out = trace(12, { live: { ...live, reviews: [{ body: 'x'.repeat(4000) + '\u001b[31m' }] } });
    expect(JSON.parse(finishPrTrace({ run: { verdict: out }, code: 0, json: true }).lines[0])).toEqual(out);
  });
  it('filters prototype-load records by their pull ref', () => {
    expect(trace(12, { sources: { 'prototype-loads': JSON.stringify({ effectiveRef: 'refs/pull/12/head', why: 'trace fixture', adopted: true }) } }).latest['prototype-loads']).toBe('trace fixture');
  });
  it('includes native queue position and the observed holder in JSON facts', () => {
    const out = trace(12, { live: { ...live, mergeQueueEntry: { position: 2, state: 'QUEUED' } }, sources: { drain: drain(12, 'behind landing holder #10') } });
    expect(out.queue).toMatchObject({ position: 2, landingHolder: '10' });
  });
  it('rejects invalid selectors before reading', () => {
    const gh = vi.fn();
    const read = createPrTraceReader({ gh });
    expect(() => read({ pr: 0, repo })).toThrow(/invalid/);
    expect(() => read({ pr: 12, repo, loopThreshold: 0 })).toThrow(/invalid/);
    expect(gh).not.toHaveBeenCalled();
  });
  it('uses declared CLI inputs and dispatches read-only', async () => {
    expect(isReadOnlyOperation(resolveOperation('pr-trace').declaration)).toBe(true);
    const declaration = prTraceOperation({ readFacts: ({ pr, repo }) => ({ pr, repo, now, live }) });
    const registry = createRegistry(); registry.register(declaration);
    const result = await runOperationCli({ declaration, argv: ['--pr=5912', `--repo=${repo}`, '--json'], registry,
      store: createMemoryRunStore(), sinks: {}, newRunId: () => 'trace-test' });
    expect(result.code).toBe(0);
    expect(result.run.verdict.pr).toBe(5912);
  });
  it('reads real bounded files and head-bound status files without modifying them', () => withRealRepo(({ root }) => {
      const log = join(root, 'review.log'), statuses = join(root, 'red-team-status');
      mkdirSync(statuses);
      writeFileSync(log, 'x'.repeat(300000) + '\nPR #5929 waiting on review\n');
      writeFileSync(join(statuses, `${encodeURIComponent(FIXTURE_SLUG)}-5929-${old}.json`),
        JSON.stringify({ repo: FIXTURE_SLUG, pr: 5929, head: old, status: 'finished' }));
      writeFileSync(join(statuses, `${encodeURIComponent(FIXTURE_SLUG)}-5929-${head}.json`), 'x'.repeat(300000));
      const before = readdirSync(root);
      const read = createPrTraceReader({ gh: () => JSON.stringify(live), now: () => now,
        env: { WE_SHARED_RUNS_DIR: join(root, 'runs') }, paths: () => ({ review: log }) });
      const out = buildPrTrace(read({ pr: 5929, repo: FIXTURE_SLUG }));
      expect(out.latest.review).toContain('waiting on review');
      expect(out.incomplete).toContain('review: bounded tail; inspect full source if needed');
      expect(out.unavailable).toContain('red-team-status');
      expect(readdirSync(root)).toEqual(before);
  }));
  it('declares a read-only operation', () => expect(isReadOnlyOperation(prTraceOperation({ readFacts: () => ({}) }))).toBe(true));
});
