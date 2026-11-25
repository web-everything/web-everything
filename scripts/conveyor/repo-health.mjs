#!/usr/bin/env node
/**
 * @file scripts/conveyor/repo-health.mjs
 * @description Per-repo health (REPO-REGISTRY-HEALTH). computeRepoHealth is pure over fetched facts;
 *   an unreadable repo is status "unknown", never healthy. Alerts fire only for repos with open PRs.
 *   CLI: prints one line per registry repo (one gh list call per repo), `--json` for machines.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRepoRegistry } from '../lib/repo-registry.mjs';

const HOUR = 3600e3;

export function computeRepoHealth({ repo, facts, error, now = Date.now(), thresholds }) {
  if (!facts) return { repo: repo.name, status: 'unknown', error: error ?? 'no data' };
  const open = [...(facts.openPrs ?? [])].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const merges = (facts.merges ?? []).map((m) => Date.parse(m.mergedAt)).filter(Number.isFinite);
  const lastMerge = merges.length ? Math.max(...merges) : null;
  return {
    repo: repo.name,
    status: 'ok',
    openPrCount: open.length,
    oldestOpenPr: open[0] ? { number: open[0].number, createdAt: open[0].createdAt } : null,
    mergesLast24h: merges.filter((t) => now - t <= 24 * HOUR).length,
    lastMergeAt: lastMerge ? new Date(lastMerge).toISOString() : null,
    lastMergeAgeHours: lastMerge ? (now - lastMerge) / HOUR : null,
    verdictsLanded: (facts.verdicts ?? []).length,
    oldestAgeHours: open[0] ? (now - Date.parse(open[0].createdAt)) / HOUR : null,
  };
}

/** One alert per repo per breach; key is stable for dedupe. */
export function healthAlerts(h, thresholds) {
  if (h.status !== 'ok' || !h.oldestOpenPr) return [];
  const noMerge = h.lastMergeAgeHours === null || h.lastMergeAgeHours > thresholds.noMergeHours;
  const oldPr = h.oldestAgeHours > thresholds.oldPrHours;
  if (!(noMerge && oldPr)) return [];
  return [{
    repo: h.repo,
    key: `${h.repo}:stale`,
    text: `${h.repo}: no merge in ${thresholds.noMergeHours}h and PR #${h.oldestOpenPr.number} open since ${h.oldestOpenPr.createdAt}`,
  }];
}

export function formatHealthLine(h) {
  if (h.status !== 'ok') return `${h.repo}: unknown (${h.error})`;
  const oldest = h.oldestOpenPr ? `oldest open #${h.oldestOpenPr.number} since ${h.oldestOpenPr.createdAt.slice(0, 10)}` : 'no open PRs';
  return `${h.repo}: ${oldest}, ${h.mergesLast24h} merged/24h, ${h.verdictsLanded} verdicts landed`;
}

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', timeout: 60000 }));
}

export function fetchFacts(slug) {
  const openPrs = gh(['pr', 'list', '-R', slug, '--state', 'open', '--limit', '100', '--json', 'number,createdAt']);
  const merges = gh(['pr', 'list', '-R', slug, '--state', 'merged', '--limit', '50', '--json', 'number,mergedAt']);
  const verdicts = gh(['pr', 'list', '-R', slug, '--state', 'open', '--limit', '100', '--json', 'number,labels'])
    .filter((p) => (p.labels ?? []).some((l) => /^review:(approved|changes|human)/.test(l.name)));
  return { openPrs, merges, verdicts };
}

export function readAllHealth({ now = Date.now(), fetch = fetchFacts } = {}) {
  const reg = loadRepoRegistry();
  return reg.repos.map((repo) => {
    try { return computeRepoHealth({ repo, facts: fetch(repo.slug), now, thresholds: reg.health }); }
    catch (e) { return computeRepoHealth({ repo, facts: null, error: String(e.message ?? e).split('\n')[0], now, thresholds: reg.health }); }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const all = readAllHealth();
  if (process.argv.includes('--json')) console.log(JSON.stringify({ health: all, alerts: all.flatMap((h) => healthAlerts(h, loadRepoRegistry().health)) }, null, 2));
  else for (const h of all) console.log(formatHealthLine(h));
}
