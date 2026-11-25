#!/usr/bin/env node
/**
 * @file scripts/conveyor/repo-health.mjs
 * @description Per-repo health (REPO-REGISTRY-HEALTH). computeRepoHealth is pure over fetched facts;
 *   an unreadable repo is status "unknown", never healthy. Alerts fire only for repos with open PRs.
 *   CLI: prints one line per registry repo, `--json` for machines. Two GitHub reads for small repos;
 *   at most ten pages per list. Incomplete reads are unknown and make the CLI exit nonzero.
 */
import { REVIEW_LABELS } from '../lib/review-labels.mjs';
import { readGhJson } from '../lib/proc-read.mjs';
import { fileURLToPath } from 'node:url';
import { loadRepoRegistry } from '../lib/repo-registry.mjs';

const HOUR = 3600e3;
const validNow = (now) => Number.isFinite(now) && Number.isFinite(new Date(now).getTime());
const validThresholds = (th) => [th?.noMergeHours, th?.oldPrHours].every((n) => Number.isFinite(n) && n > 0);

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
  if (!validNow(now)) return unknown('invalid now');
  if (!validThresholds(th)) return unknown('invalid thresholds');
  if (!Array.isArray(facts.openPrs) || !Array.isArray(facts.merges)) return unknown('incomplete facts');
  if (facts.openPrs.some((p) => !Number.isSafeInteger(p?.number) || p.number <= 0
    || !Array.isArray(p.labels) || p.labels.some((l) => typeof l?.name !== 'string' || !l.name.trim()))) return unknown('incomplete PR facts');
  const openTimes = facts.openPrs.map((p) => typeof p?.createdAt === 'string' ? Date.parse(p.createdAt) : NaN);
  const mergeTimes = facts.merges.map((m) => typeof m?.mergedAt === 'string' ? Date.parse(m.mergedAt) : NaN);
  if ([...openTimes, ...mergeTimes].some((t) => !Number.isFinite(t))) return unknown('invalid timestamp');
  if (openTimes.some((t) => t > now)) return unknown('PR timestamp in the future');
  if (mergeTimes.some((t) => t > now + 5 * 60e3)) return unknown('merge timestamp in the future');
  // A date-filtered merge read establishes staleness only inside its declared horizon.
  if (facts.mergeWindowStart !== undefined && (!Number.isFinite(facts.mergeWindowStart)
    || facts.mergeWindowStart > now - Math.max(24, th.noMergeHours) * HOUR)) return unknown('incomplete merge window');
  const open = [...facts.openPrs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const merges = mergeTimes;
  const lastMerge = merges.length ? Math.max(...merges) : null;
  return {
    repo: repo.name,
    status: 'ok',
    openPrCount: open.length,
    oldestOpenPr: open[0] ? { number: open[0].number, createdAt: open[0].createdAt } : null,
    mergesLast24h: merges.filter((t) => now - t <= 24 * HOUR).length,
    lastMergeAt: lastMerge !== null ? new Date(lastMerge).toISOString() : null,
    lastMergeAgeHours: lastMerge !== null ? (now - lastMerge) / HOUR : null,
    // null above means no observed merge in this window, not that the repo never merged.
    mergeWindowStart: facts.mergeWindowStart ?? null,
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

const gh = (args) => readGhJson(args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });

const OPEN_QUERY = `query($owner:String!,$repo:String!,$cursor:String) {
  repository(owner:$owner,name:$repo) {
    pullRequests(first:100,after:$cursor,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}) {
      nodes { number createdAt labels(first:100) { nodes { name } pageInfo { hasNextPage } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const MERGED_QUERY = `query($search:String!,$cursor:String) {
  search(query:$search,type:ISSUE,first:100,after:$cursor) {
    issueCount nodes { ... on PullRequest { number mergedAt } }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** Read a complete connection within a fixed budget; never return a truncated prefix. */
function readPages(query, fields, select, read, { search = false } = {}) {
  const nodes = [];
  const cursors = new Set();
  const numbers = new Set();
  let cursor;
  for (let page = 0; page < 10; page++) {
    const args = ['api', 'graphql', '-f', `query=${query}`, ...fields];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const result = read(args);
    if (result?.errors) throw new Error('incomplete GraphQL response');
    const connection = select(result?.data);
    if (!Array.isArray(connection?.nodes) || connection.nodes.length > 100
      || typeof connection.pageInfo?.hasNextPage !== 'boolean') throw new Error('incomplete page');
    if (search && (!Number.isSafeInteger(connection.issueCount) || connection.issueCount < 0
      || connection.issueCount > 1000)) throw new Error('merge search exceeds complete-read limit');
    for (const node of connection.nodes) {
      if (!Number.isSafeInteger(node?.number) || node.number <= 0 || numbers.has(node.number)) throw new Error('inconsistent PR page');
      numbers.add(node.number);
      nodes.push(node);
    }
    if (!connection.pageInfo.hasNextPage) {
      if (search && nodes.length !== connection.issueCount) throw new Error('incomplete merge search');
      return nodes;
    }
    cursor = connection.pageInfo.endCursor;
    if (!connection.nodes.length || typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('invalid pagination cursor');
    cursors.add(cursor);
  }
  throw new Error('page budget exhausted; repo health unknown');
}

export function fetchFacts(slug, { now = Date.now(), thresholds = loadRepoRegistry().health, gh: read = gh } = {}) {
  if (!validNow(now) || !validThresholds(thresholds)) throw new Error('invalid health inputs');
  if (typeof slug !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error('invalid repo slug');
  const [owner, repo] = slug.split('/');
  const open = readPages(OPEN_QUERY, ['-f', `owner=${owner}`, '-f', `repo=${repo}`], (data) => data?.repository?.pullRequests, read);
  const openPrs = open.map((pr) => {
    if (!Array.isArray(pr.labels?.nodes) || pr.labels.pageInfo?.hasNextPage !== false) throw new Error('incomplete PR labels');
    return { ...pr, labels: pr.labels.nodes };
  });
  // Search by merge date, so a newly merged old PR is included. The horizon covers
  // both the 24h counter and the staleness threshold; older history is not needed.
  const mergeWindowStart = now - Math.max(24, thresholds.noMergeHours) * HOUR;
  const search = `repo:${slug} is:pr is:merged merged:>=${new Date(mergeWindowStart).toISOString()}`;
  const merges = readPages(MERGED_QUERY, ['-f', `search=${search}`], (data) => data?.search, read, { search: true });
  return { openPrs, merges, mergeWindowStart };
}

export function readAllHealth({ now = Date.now(), fetch = fetchFacts } = {}) {
  const reg = loadRepoRegistry();
  return reg.repos.map((repo) => {
    try { return computeRepoHealth({ repo, facts: fetch(repo.slug, { now, thresholds: reg.health }), now, thresholds: reg.health }); }
    catch (e) { return computeRepoHealth({ repo, facts: null, error: String(e?.message ?? e).split('\n')[0], now, thresholds: reg.health }); }
  });
}

/** Shared by the executable and hermetic CLI tests; returns the process exit code. */
export function runCli({ argv = process.argv.slice(2), write = console.log, ...options } = {}) {
  const all = readAllHealth(options);
  if (argv.includes('--json')) write(JSON.stringify({ health: all, alerts: all.flatMap((h) => healthAlerts(h, loadRepoRegistry().health)) }, null, 2));
  else for (const h of all) write(formatHealthLine(h));
  return all.some((h) => h.status !== 'ok') ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = runCli();
