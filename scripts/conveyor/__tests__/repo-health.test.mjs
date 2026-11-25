/**
 * @file scripts/conveyor/__tests__/repo-health.test.mjs
 * @description Pins the pure per-repo health reader (REPO-REGISTRY-HEALTH).
 */
import { describe, it, expect } from 'vitest';
import { computeRepoHealth, formatHealthLine, healthAlerts, countVerdicts } from '../repo-health.mjs';
import { REVIEW_LABELS } from '../../lib/review-labels.mjs';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600e3).toISOString();
const thresholds = { noMergeHours: 24, oldPrHours: 48 };
const run = (facts, extra = {}) => computeRepoHealth({ repo: { name: 'r' }, facts, now: NOW, thresholds, ...extra });

describe('repo health', () => {
  it('a repo with no merge in N hours and an open PR older than X raises one alert', () => {
    const h = computeRepoHealth({
      repo: { name: 'plateau-app' },
      facts: { openPrs: [{ number: 229, createdAt: '2026-11-15T12:00:00Z', labels: [] }], merges: [{ mergedAt: hoursAgo(100) }] },
      now: NOW, thresholds,
    });
    expect(h.oldestOpenPr).toEqual({ number: 229, createdAt: '2026-11-15T12:00:00Z' });
    expect(h.mergesLast24h).toBe(0);
    expect(h.verdictsLanded).toBe(0);
    const alerts = healthAlerts(h, thresholds);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe('plateau-app:stale');
    expect(formatHealthLine(h)).toMatch(/plateau-app.*#229/);
  });

  it('a quiet repo with no open PRs raises no alert', () => {
    expect(healthAlerts(run({ openPrs: [], merges: [] }), thresholds)).toEqual([]);
  });

  it('a recent merge keeps the repo healthy even with an old open PR', () => {
    const h = run({ openPrs: [{ number: 1, createdAt: hoursAgo(200), labels: [] }], merges: [{ mergedAt: hoursAgo(2) }] });
    expect(h.mergesLast24h).toBe(1);
    expect(healthAlerts(h, thresholds)).toEqual([]);
  });

  it('counts verdicts by the labels the review flow really sets, not approved', () => {
    const lbl = (...n) => n.map((name) => ({ name }));
    const prs = [
      { labels: lbl(REVIEW_LABELS.accepted) },
      { labels: lbl(REVIEW_LABELS.changes, 'bug') },
      { labels: lbl(REVIEW_LABELS.pending) },
      { labels: lbl('review:approved') },
      { labels: [] },
    ];
    expect(countVerdicts(prs)).toBe(2);
  });

  it('an unreadable repo (API error) shows unknown, never healthy', () => {
    const h = computeRepoHealth({ repo: { name: 'plateau-app' }, facts: null, error: 'HTTP 502', now: NOW, thresholds });
    expect(h.status).toBe('unknown');
    expect(formatHealthLine(h)).toMatch(/unknown/);
    expect(formatHealthLine(h)).not.toMatch(/healthy/);
  });

  it('fails closed to unknown on missing facts, bad timestamps, future merges and bad thresholds', () => {
    expect(run({}).status).toBe('unknown');
    expect(run({ openPrs: [{ number: 1, createdAt: 'nope' }], merges: [] }).status).toBe('unknown');
    expect(run({ openPrs: [], merges: [{ mergedAt: 'nope' }] }).status).toBe('unknown');
    expect(run({ openPrs: [], merges: [{ mergedAt: hoursAgo(-10) }] }).status).toBe('unknown');
    expect(run({ openPrs: [], merges: [] }, { thresholds: {} }).status).toBe('unknown');
    expect(run({ openPrs: [], merges: [] }, { thresholds: { noMergeHours: 'x', oldPrHours: 48 } }).status).toBe('unknown');
  });
});
