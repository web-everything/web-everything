/**
 * @file scripts/conveyor/__tests__/repo-health.test.mjs
 * @description Pins the pure per-repo health reader (REPO-REGISTRY-HEALTH).
 */
import { describe, it, expect } from 'vitest';
import { computeRepoHealth, formatHealthLine, healthAlerts } from '../repo-health.mjs';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600e3).toISOString();
const thresholds = { noMergeHours: 24, oldPrHours: 48 };

describe('repo health', () => {
  it('a repo with no merge in N hours and an open PR older than X raises one alert', () => {
    const h = computeRepoHealth({
      repo: { name: 'plateau-app' },
      facts: { openPrs: [{ number: 229, createdAt: '2026-11-15T12:00:00Z' }], merges: [{ mergedAt: hoursAgo(100) }], verdicts: [] },
      now: NOW, thresholds,
    });
    expect(h.oldestOpenPr).toEqual({ number: 229, createdAt: '2026-11-15T12:00:00Z' });
    expect(h.mergesLast24h).toBe(0);
    expect(h.verdictsLanded).toBe(0);
    const alerts = healthAlerts(h, thresholds);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].repo).toBe('plateau-app');
    expect(alerts[0].key).toBe('plateau-app:stale');
    expect(formatHealthLine(h)).toMatch(/plateau-app.*#229/);
  });

  it('a quiet repo with no open PRs raises no alert', () => {
    const h = computeRepoHealth({ repo: { name: 'frontierui' }, facts: { openPrs: [], merges: [], verdicts: [] }, now: NOW, thresholds });
    expect(healthAlerts(h, thresholds)).toEqual([]);
  });

  it('a recent merge keeps the repo healthy even with an old open PR', () => {
    const h = computeRepoHealth({
      repo: { name: 'web-everything' },
      facts: { openPrs: [{ number: 1, createdAt: hoursAgo(200) }], merges: [{ mergedAt: hoursAgo(2) }], verdicts: [1] },
      now: NOW, thresholds,
    });
    expect(h.mergesLast24h).toBe(1);
    expect(healthAlerts(h, thresholds)).toEqual([]);
  });

  it('an unreadable repo (API error) shows unknown, never healthy', () => {
    const h = computeRepoHealth({ repo: { name: 'plateau-app' }, facts: null, error: 'HTTP 502', now: NOW, thresholds });
    expect(h.status).toBe('unknown');
    expect(formatHealthLine(h)).toMatch(/unknown/);
    expect(formatHealthLine(h)).not.toMatch(/healthy/);
  });
});
