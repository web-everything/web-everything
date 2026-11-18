/**
 * @file scripts/operations/pr-ownership-io.mjs
 * @description #4056 — the injected reads behind `pr-ownership.mjs`. Read-only: no sink, no dispatch, no lease.
 *
 * THE RECONCILE PASS IS CALLED, NOT COPIED. Each constellation repo gets one `runReconcilePass` (it plans and
 * dispatches nothing — see that file's own header). Its readers are wrapped only to KEEP what it already read:
 * the fully enriched PR list (the last enrich step's output, so `fixClaim` rides along), the enriched agent
 * listing, and the required-check set `classifyPr` needs for the same phase the pass computed. `claude agents
 * --json` is read once and shared across repos.
 *
 * TRANSCRIPT AGE comes from `hung-session.mjs#readHungInfo`'s `ageMs` — the same reader the reconcile pass's own
 * hung pre-pass uses, which prefers the transcript's embedded entry timestamps over its mtime (that header's
 * incident: an mtime bumped hours after the last real entry) and falls back to mtime only when no entry carries
 * one. It is attached to the agent row, where `bindAgents` copies it onto each bound row.
 *
 * Everything else is best-effort and lands in `gaps` rather than failing the read: lanes (`lane-pool.mjs status
 * --json`, the read `stale-state` already makes), daemon liveness (`runner-activity`'s own bounded reader), and
 * each PR's phase-entry time (its GitHub timeline, `stuck-pr-watch.mjs#defaultListTimelineEvents`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONSTELLATION_REPOS, capableRepos } from '../lib/constellation-repos.mjs';
import { getRequiredStatusChecks } from '../lib/required-status-checks.mjs';
import {
  runReconcilePass, defaultReadAgents, enrichAgents, enrichPrsWithFixClaims,
} from '../conveyor/reconcile-pass.mjs';
import { bindAgents } from '../conveyor/reconcile-core.mjs';
import { readHungInfo, resolveHungThresholdMs } from '../conveyor/hung-session.mjs';
import { classifyPr } from '../progress-board.mjs';
import { itemNumsFromPr } from '../lib/open-pr-items.mjs';
import { defaultListTimelineEvents } from '../conveyor/stuck-pr-watch.mjs';
import { REPO_ROOT } from './claim-io.mjs';
import { createRunnerActivityReader } from './runner-activity-io.mjs';
import { assessRunnerActivity } from './runner-activity.mjs';
import { phaseSinceFrom } from './pr-ownership.mjs';

/** The card a PR delivers: the first item number off its branch/title, else a pre-number `x…` hash branch. */
export function cardForPr(pr) {
  const [num] = itemNumsFromPr(pr?.headRefName ?? '', pr?.title ?? '');
  if (num) return num;
  const hash = /(?:^|\/)lane\/(x[0-9a-z]{6})(?=$|[-/])/.exec(String(pr?.headRefName ?? ''));
  return hash ? hash[1] : null;
}

/**
 * THE shared PR→card map (#3932's addition): `{ '${repo}:${pr}': card }` — the exact shape
 * `agent-activity.mjs`'s `prToCard` input takes, so /wip's per-card and per-PR views read the same join. A PR
 * that names no card is omitted, so a lookup miss means "unknown".
 * @param {Array<{repo:string, prs:Array<object>}>} repos
 */
export function buildPrToCardMap(repos) {
  const map = {};
  for (const { repo, prs } of Array.isArray(repos) ? repos : []) {
    for (const pr of Array.isArray(prs) ? prs : []) {
      const card = cardForPr(pr);
      if (card && Number.isInteger(Number(pr?.number))) map[`${repo}:${Number(pr.number)}`] = card;
    }
  }
  return map;
}

/**
 * One raw PR → the fact row `pr-ownership.mjs#assessPrOwnership` reads: phase through `classifyPr` and bound
 * sessions through `bindAgents`, both exactly as the reconcile pass computes them.
 */
export function prFacts(pr, { repo, agents, requiredChecks, card = null, phaseSince = null }) {
  return {
    repo, number: Number(pr.number), headRefName: pr.headRefName ?? null, baseRefName: pr.baseRefName ?? null,
    isDraft: pr.isDraft === true, fixClaim: pr.fixClaim ?? null, card, phaseSince,
    phase: classifyPr(pr, requiredChecks),
    bound: bindAgents(pr, agents, repo).map((b) => ({
      name: b.agent?.name ?? null, sessionId: b.agent?.sessionId ?? null, state: b.agent?.state ?? null,
      selfReportedDone: b.agent?.selfReportedDone === true, transcriptAgeMs: b.transcriptAgeMs,
    })),
  };
}

/** A repo's checkout on this host: WE is the checkout this runs from; the others use their declared `path`. */
function checkoutFor(key, root) {
  if (key === 'we') return root;
  const path = String(CONSTELLATION_REPOS[key]?.path ?? '').replace(/^\$HOME/, homedir());
  return path || null;
}

/** Attach each session's transcript age. A read that fails leaves `transcriptAgeMs` unset — never a guess. */
export function withTranscriptAges(agents, { hungInfoFor = readHungInfo, now = Date.now(), thresholdMs = resolveHungThresholdMs() } = {}) {
  return (Array.isArray(agents) ? agents : []).map((a) => {
    let ageMs = null;
    try { ageMs = hungInfoFor(a, now, thresholdMs)?.ageMs ?? null; } catch { ageMs = null; }
    return Number.isFinite(ageMs) ? { ...a, transcriptAgeMs: ageMs } : a;
  });
}

/**
 * Bind every external read, including the clock, so the suite runs on fixtures with no `gh`/`claude`/git.
 * @returns {() => {observedAt:string, repos:Array<object>, daemons:Array<object>, gaps:string[]}}
 */
export function createPrOwnershipReader({
  root = REPO_ROOT, repoKeys = Object.keys(capableRepos()),
  reconcile = runReconcilePass, readAgents = defaultReadAgents, enrich = enrichAgents,
  enrichFixClaims = enrichPrsWithFixClaims, readRequiredChecks = getRequiredStatusChecks,
  hungInfoFor = readHungInfo, readTimeline = defaultListTimelineEvents,
  readActivity = createRunnerActivityReader(), run = execFileSync, pathExists = existsSync,
  now = Date.now,
} = {}) {
  const readLanes = (checkout) => {
    const out = run(process.execPath, [join(root, 'scripts/lane-pool.mjs'), 'status', '--json', `--repo=${checkout}`], {
      cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    const parsed = JSON.parse(String(out));
    if (!Array.isArray(parsed.lanes)) throw new Error('status returned no lanes array');
    return parsed.lanes;
  };

  return () => {
    const nowMs = now();
    const observedAt = new Date(nowMs).toISOString();
    const gaps = [
      'Time in phase is measured from the latest label or commit event; a base-branch move is not on the timeline.',
      'drain is not a runner-activity daemon, so its liveness reads unknown and never raises an orphan flag.',
    ];

    let daemons = [];
    try { daemons = assessRunnerActivity(readActivity({ limit: 0 })).runners; }
    catch (error) { gaps.push(`runner-activity unreadable, every owner daemon reads unknown: ${error.message}`); }

    // One listing for every repo, enriched once, with transcript ages attached before any binding happens.
    let agentsOnce = null;
    const sharedAgents = () => {
      if (!agentsOnce) agentsOnce = withTranscriptAges(enrich(readAgents({})), { hungInfoFor, now: nowMs });
      return agentsOnce;
    };

    const repos = [];
    for (const key of repoKeys) {
      const { slug } = CONSTELLATION_REPOS[key];
      const kept = {};
      let plan;
      try {
        plan = reconcile({
          repo: slug, now: nowMs,
          readAgents: () => null,
          enrich: () => (kept.agents = sharedAgents()),
          enrichFixClaims: (prs, o) => (kept.prs = enrichFixClaims(prs, o)),
          readRequiredChecks: (o) => (kept.required = readRequiredChecks(o)),
        });
      } catch (error) {
        gaps.push(`${key}: reconcile dry-run failed, its PRs are not listed: ${error.message}`);
        continue;
      }
      const prs = kept.prs ?? [];

      let lanes = [];
      const checkout = checkoutFor(key, root);
      if (!checkout || !pathExists(checkout)) gaps.push(`${key}: no checkout on this host, lanes not read`);
      else {
        try { lanes = readLanes(checkout); }
        catch (error) { gaps.push(`${key}: lane enumeration failed: ${error.message}`); }
      }

      const phaseSince = {};
      for (const pr of prs) {
        try { phaseSince[Number(pr.number)] = phaseSinceFrom(readTimeline({ number: pr.number, repo: slug })); }
        catch (error) {
          phaseSince[Number(pr.number)] = null;
          gaps.push(`${key}#${pr.number}: timeline unreadable, time in phase unknown: ${error.message}`);
        }
      }

      repos.push({
        repo: key, raw: prs, agents: kept.agents ?? sharedAgents(), requiredChecks: kept.required?.checks,
        plan: { dispatch: plan.dispatch ?? [], refusals: plan.refusals ?? [], notes: plan.notes ?? [] },
        lanes, phaseSince, defaultBranch: 'main',
      });
    }
    const prToCard = buildPrToCardMap(repos.map((r) => ({ repo: r.repo, prs: r.raw })));
    return {
      observedAt, daemons, gaps, prToCard,
      repos: repos.map(({ raw, agents, requiredChecks, phaseSince, ...r }) => ({
        ...r,
        prs: raw.map((pr) => prFacts(pr, {
          repo: r.repo, agents, requiredChecks,
          card: prToCard[`${r.repo}:${Number(pr.number)}`] ?? null, phaseSince: phaseSince[Number(pr.number)] ?? null,
        })),
      })),
    };
  };
}
