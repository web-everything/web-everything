import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foldDaemonMemory, stepEpisodes, emptyHealthState, runHealthTick } from '../../health-watch-core.mjs';
import { probeDaemonLogs, probeOperationRuns } from '../../health-watch.mjs';
import { recordPrAttempts, ATTEMPT_WINDOW_MS } from '../../health-pr-attempts.mjs';
import smell from '../repeated-pr-attempts.mjs';

const NOW = Date.parse('2026-09-30T16:00:00Z');
const tick = 'review-daemon: tick (web-everything/web-everything) — 1 owed, dispatched 0, failed 1\n';
// Live #3176 outcome line: the diagnostic's #3439 is NOT the affected PR.
const failure = (n = 8) => `review-daemon: web-everything/web-everything#3176 failed (non-fatal): review-dispatch: the dispatching checkout is ${n} commit(s) behind origin/main — refusing to dispatch a review that would run STALE code from this checkout's own import path (#3439).\n`;
const fold = (text, prev, at = NOW, bootstrap = false) => foldDaemonMemory(prev, {
  name: 'review-daemon', text, mtimeMs: at, sizeBytes: text.length, bootstrap, defaultIntervalMs: 120_000,
}, at);
const evaluate = (mem, now = NOW, operationRuns = []) => smell.evaluate({ operationRuns }, { now, daemons: { review: mem } });

describe('repeated attempts on the same PR', () => {
  const refusal = (pr, reason) => `reconcile-fix-dispatch-daemon: reconcile-refused ${reason.split(': ')[0]} web-everything/web-everything PR #${pr} — ${reason.split(': ').slice(1).join(': ')}\n`;
  const waits = [
    [3215, "cap-exhausted: the PR's own durable attempt count is 5 against a cap of 5 — auto-repair is exhausted here and a person must take it"],
    [3215, 'scope-overlap: we:scripts/lib/gh-throttle.mjs overlaps in-flight fix PR #3245 — waiting 2nd behind #3245 on we:scripts/lib/gh-throttle.mjs — serializing, retrying next pass'],
    [3253, 'draft: PR is still a draft — no independent review is dispatched until it is promoted to ready for review, which happens once its required checks are all green (draft-first PRs)'],
    [3253, 'human-gated: review:human — awaiting the human ceremony'],
    [3253, 'already-reviewed-head: this exact head (`abc`) already carries a `reviewed-sha` accept marker from a prior review'],
    [3215, 'ci-heal-escalated: ci-heal already escalated this exact head (`abc`) to a human — re-dispatching would re-ask the identical already-answered question'],
  ];

  it.each(waits)('ignores the recorded expected wait on #%i: %s', (pr, reason) => {
    expect(evaluate(fold((tick + refusal(pr, reason)).repeat(8)))).toEqual([]);
    // Before this fix the rows were already persisted; neither cursor reset nor
    // waiting for the hour window to expire should be needed to clear them.
    const mem = { prAttempts: Array.from({ length: 8 }, () => ({
      pr: `web-everything/web-everything#${pr}`, action: 'fix-dispatch', reason, at: NOW,
    })) };
    expect(evaluate(mem)).toEqual([]);
  });

  it('closes false #3215/#3253 episodes through two normal clean ticks', () => {
    const results = [3215, 3253].map(pr => ({ subject: `web-everything/web-everything#${pr}`, breach: true }));
    let state = stepEpisodes(emptyHealthState(), [{ smell, results }], NOW - 1).state;
    state.daemons = { fix: { prAttempts: waits.map(([pr, reason]) => ({
      pr: `web-everything/web-everything#${pr}`, action: 'fix-dispatch', reason, at: NOW,
    })) } };
    const first = runHealthTick(state, { daemonLogs: [] }, [smell], NOW);
    expect(first.transitions.filter(t => t.type === 'closed')).toHaveLength(0);
    const second = runHealthTick(first.state, { daemonLogs: [] }, [smell], NOW + 1);
    expect(second.transitions.filter(t => t.type === 'closed').map(t => t.episode.subject).sort())
      .toEqual(results.map(r => r.subject).sort());
  });

  it('keeps newer machine failures on a human-gated PR and unnamed overlap refusals', () => {
    const held = waits.map(([pr, reason]) => refusal(pr, reason)).join('');
    const failures = [
      'dispatch-failed: review-dispatch child crashed',
      'dispatch-failed: fix-dispatch refused unexpectedly',
      'missing-run-cap-exhausted: recovery cap exhausted',
      'dispatch-failed: open-pr submit failed',
      'scope-overlap: fix-dispatch cannot determine blocker',
    ].map(reason => refusal(3253, reason)).join('');
    const result = smell.evaluate({ prs: [{ repo: 'web-everything/web-everything', number: 3253,
      labels: [{ name: 'review:human' }] }] }, { now: NOW, daemons: { fix: fold(held + failures) } });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ subject: 'web-everything/web-everything#3253', breach: true, measure: { attempts: 5 } });
  });

  it('does not treat a failed action or failed effect as a wait just because its error mentions a gate', () => {
    const reason = waits[0][1];
    const mem = fold(`fix-daemon: web-everything/web-everything#3215 failed (non-fatal): ${reason}\n`.repeat(5));
    expect(evaluate(mem)[0].breach).toBe(true);
    const records = Array.from({ length: 5 }, (_, i) => ({ id: `run-${i}`, op: 'open-pr',
      input: { repo: 'web-everything/web-everything', pr: 3215 }, effects: [{ key: 'submit', status: 'failed',
        lastAttemptAt: new Date(NOW).toISOString(), error: reason }] }));
    expect(evaluate(fold(''), NOW, records)[0].breach).toBe(true);
  });

  it('replays #3176 and opens an episode on attempt five, regardless of other PR progress', () => {
    let mem;
    for (let i = 0; i < 5; i++) mem = fold(tick + failure(8 + i), mem, NOW - (4 - i) * 120_000);
    const results = evaluate(mem);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ subject: 'web-everything/web-everything#3176', breach: true,
      measure: { attempts: 5, actions: { 'review-dispatch': 5 } } });
    expect(results[0].summary).toContain('12 commit(s)');
    const result = stepEpisodes(emptyHealthState(), [{ smell, results }], NOW);
    expect(result.transitions[0].type).toBe('opened');
  });

  it('does not double count a bootstrapped replacement log', () => {
    const text = (tick + failure()).repeat(3);
    const mem = fold(text, undefined, NOW, true);
    expect(evaluate(fold(text, mem, NOW, true))[0].measure.attempts).toBe(3);
  });

  it('does not fire for a normal single retry or unrelated PRs', () => {
    expect(evaluate(fold(tick + failure() + failure()))[0].breach).toBe(false);
    const text = Array.from({ length: 5 }, (_, i) => tick + failure().replace('#3176', `#${3200 + i}`)).join('');
    expect(evaluate(fold(text)).every((r) => !r.breach)).toBe(true);
  });

  it('expires observations and estimates bootstrap tick ages instead of making old logs fresh', () => {
    const mem = fold((tick + failure()).repeat(40), undefined, NOW, true);
    expect(evaluate(mem)[0].measure.attempts).toBe(30);
    expect(evaluate(mem, NOW + ATTEMPT_WINDOW_MS)).toEqual([]);
    expect(evaluate(fold('', mem, NOW + ATTEMPT_WINDOW_MS))).toEqual([]);
  });

  it('survives persisted memory and complete-line cursors without recounting unchanged logs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-attempts-'));
    try {
      const path = join(dir, 'review-daemon.log');
      writeFileSync(path, tick + failure().trimEnd());
      const first = probeDaemonLogs(dir);
      let mem = foldDaemonMemory(undefined, first.samples[0], Date.now());
      appendFileSync(path, '\n' + (tick + failure()).repeat(4));
      const next = probeDaemonLogs(dir, first.cursors);
      mem = foldDaemonMemory(JSON.parse(JSON.stringify(mem)), next.samples[0], Date.now());
      expect(evaluate(mem, Date.now())[0].measure.attempts).toBe(5);
      const unchanged = probeDaemonLogs(dir, next.cursors);
      mem = foldDaemonMemory(mem, unchanged.samples[0], Date.now());
      expect(evaluate(mem, Date.now())[0].measure.attempts).toBe(5);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('aggregates mixed actions, including cap-exhausted recovery, but ignores normal holds', () => {
    const lines = [
      'refused dispatch-failed web-everything/web-everything PR #3209 — fix-dispatch refused',
      'reconcile-refused missing-run-cap-exhausted web-everything/web-everything PR #3209 — cap exhausted',
      'hung-ci-recovery web-everything/web-everything PR #3209 run 44 — applied rerun — still stuck',
      'main-red-rebase web-everything/web-everything PR #3209 (lane/x) — FAILED conflict fix',
      'refused dispatch-failed web-everything/web-everything PR #3209 — open-pr failed',
      ...Array(8).fill('reconcile-refused live-process web-everything/web-everything PR #3209 — worker alive'),
    ].map((s) => `reconcile-fix-dispatch-daemon: ${s}\n`).join('');
    const result = evaluate(fold(lines))[0];
    expect(result.measure.attempts).toBe(5);
    expect(result.breach).toBe(true);
  });

  it('reads failed effects from local run records, dedupes snapshots, and does not inflate lifetime counters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-runs-'));
    try {
      mkdirSync(join(dir, '.operations', 'runs'), { recursive: true });
      const record = { id: 'run-1', op: 'open-pr', input: { repo: 'web-everything/web-everything', pr: 3209 },
        effects: [{ key: 'submit', status: 'failed', attempts: 99, lastAttemptAt: new Date(NOW).toISOString(), error: 'submit failed' }] };
      writeFileSync(join(dir, '.operations', 'runs', 'run-1.json'), JSON.stringify(record));
      const records = probeOperationRuns({ roots: [dir], jobsRoot: null });
      expect(recordPrAttempts([...records, ...records], NOW)).toHaveLength(1);
      expect(evaluate(fold(''), NOW, records)[0]).toMatchObject({ breach: false, measure: { attempts: 1 } });
      expect(recordPrAttempts(records, NOW + ATTEMPT_WINDOW_MS)).toEqual([]);
      const five = Array.from({ length: 5 }, (_, i) => ({ ...record, id: `run-${i}` }));
      expect(evaluate(fold(''), NOW, five)[0].breach).toBe(true);
      const logged = fold('build-daemon: web-everything/web-everything#3209 failed (non-fatal): open-pr submit failed\n');
      expect(evaluate(logged, NOW, five)[0].measure.attempts).toBe(5);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
