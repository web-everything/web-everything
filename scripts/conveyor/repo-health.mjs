#!/usr/bin/env node
/**
 * @file scripts/conveyor/repo-health.mjs
 * @description Per-repo health (REPO-REGISTRY-HEALTH). computeRepoHealth is pure over fetched facts;
 *   an unreadable repo is status "unknown", never healthy. Alerts fire only for repos with open PRs.
 *   CLI: prints one line per registry repo (one gh list call per repo), `--json` for machines.
 */
import { REVIEW_LABELS } from '../lib/review-labels.mjs';
import { readGhJson } from '../lib/proc-read.mjs';
import { fileURLToPath } from 'node:url';
import { loadRepoRegistry } from '../lib/repo-registry.mjs';

const HOUR = 3600e3;

/** Open PRs carrying a reviewer verdict label the review flow really sets (review-labels.mjs). */
export function countVerdicts(prs) {
  const verdict = new Set([REVIEW_LABELS.accepted, REVIEW_LABELS.changes]);
  return prs.filter((p) => (p.labels ?? []).some((l) => verdict.has(l.name))).length;
}

export function computeRepoHealth({ repo, facts, error, now = Date.now(), thresholds }) {
  const unknown = (why) => ({ repo: repo.name, status: 'unknown', error: why });
  if (!facts) return unknown(error ?? 'no data');
  // Fail closed (SHIP-API-014): inconsistent evidence is unknown, never a number.
  const th = thresholds ?? {};
  if (![th.noMergeHours, th.oldPrHours].every((n) => Number.isFinite(n) && n > 0)) return unknown('invalid thresholds');
  if (!Array.isArray(facts.openPrs) || !Array.isArray(facts.merges)) return unknown('incomplete facts');
  const openTimes = facts.openPrs.map((p) => Date.parse(p?.createdAt));
  const mergeTimes = facts.merges.map((m) => Date.parse(m?.mergedAt));
  if ([...openTimes, ...mergeTimes].some((t) => !Number.isFinite(t))) return unknown('invalid timestamp');
  if (mergeTimes.some((t) => t > now + 5 * 60e3)) return unknown('merge timestamp in the future');
  const open = [...facts.openPrs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const merges = mergeTimes;
  const lastMerge = merges.length ? Math.max(...merges) : null;
  return {
    repo: repo.name,
    status: 'ok',
    openPrCount: open.length,
    oldestOpenPr: open[0] ? { number: open[0].number, createdAt: open[0].createdAt } : null,
    mergesLast24h: merges.filter((t) => now - t <= 24 * HOUR).length,
    lastMergeAt: lastMerge ? new Date(lastMerge).toISOString() : null,
    lastMergeAgeHours: lastMerge ? (now - lastMerge) / HOUR : null,
    verdictsLanded: countVerdicts(open),
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

const gh = (args) => readGhJson(args, { timeout: 60000 });

export function fetchFacts(slug) {
  const openPrs = gh(['pr', 'list', '-R', slug, '--state', 'open', '--limit', '100', '--json', 'number,createdAt,labels']);
  const merges = gh(['pr', 'list', '-R', slug, '--state', 'merged', '--limit', '50', '--json', 'number,mergedAt']);
  return { openPrs, merges };
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
  if (all.some((h) => h.status !== 'ok')) process.exitCode = 1;
}
