/**
 * @file scripts/conveyor/review-ci-gate.mjs
 * @description Review does not wait for green CI when every CI failure on the PR is INHERITED from main's current red.
 *
 * LIVE 2026-10-10 ~20:00Z: main was red since 18:44Z on `record-referral-ruling.test.mjs` ("#4979 the sanctioned
 * writer"). The review daemon refused #4708, #4715, #4786 and #4805 with `owed-ci-rerun` / `review-ci`, although
 * their ONLY failure was main's — 3 reviews in an hour. Operator (16:05 ET): "reviews would not care about a test as
 * they run nothing". A review reads the diff; a failure the PR inherited from main says nothing about the diff.
 *
 * INHERITED = the PR's failing job is one main's current red run fails too, AND every failing test of that job is one
 * main's red run fails too. Anything else is the PR's OWN failure, and one own failure is enough to wait.
 *
 * Reuses `main-ci-red-core.mjs`, never re-derives it:
 *   - the facts are the shapes its IO already extracts (`main-ci-red-io.mjs#readRunJobs` → `failed:[{name}]`,
 *     `#readFailingTests` → test titles, `#probeMainCiRuns` → `failing:{jobs, tests}`);
 *   - summary jobs (`mainCiRedSummaryJobs`: `test` ← test shards, `daemon-soak` ← soak shards) are never a cause of
 *     their own, exactly as in `planCombinedFix`'s "owed elsewhere" rule: a red `test` summary is judged by its shards.
 *
 * FAILS CLOSED: main not proven red, the PR's job list incomplete, a required check pending / missing / on another
 * head, a failing job whose tests could not be read or that names no test → the review keeps waiting.
 *
 * The MERGE gate is untouched: a PR reviewed this way still cannot land until its CI re-runs green.
 * PURE: no fs, no clock, no gh.
 */

import { MAIN_CI_RED_DEFAULTS } from './main-ci-red-core.mjs';

/** Setting `review.ciGate`. `green-only` = before this card (review always waits for green required checks). */
export const REVIEW_CI_GATE_SETTING = 'ciGate';
export const REVIEW_CI_GATE_ENV = 'WE_REVIEW_CI_GATE';
export const REVIEW_CI_GATE_VALUES = Object.freeze(['green-only', 'ignore-inherited-main-red']);
export const REVIEW_CI_GATE_DEFAULT = 'ignore-inherited-main-red';

const asGate = (v) => { const s = String(v ?? '').trim().toLowerCase(); return REVIEW_CI_GATE_VALUES.includes(s) ? s : null; };

/**
 * PURE: the cascade for `review.ciGate` — standard default → platform preference (`platform.review`) → tool override
 * (`repo`, e.g. `we:scripts/settings/review.json`) → env `WE_REVIEW_CI_GATE`. An invalid layer is skipped, never trusted.
 * @returns {{value:'green-only'|'ignore-inherited-main-red', source:'standard'|'platform'|'repo'|'env'}}
 */
export function resolveReviewCiGate({ env = {}, platform = null, repo = null } = {}) {
  let out = { value: REVIEW_CI_GATE_DEFAULT, source: 'standard' };
  const p = asGate(platform?.review?.[REVIEW_CI_GATE_SETTING]);
  if (p) out = { value: p, source: 'platform' };
  const r = asGate(repo?.[REVIEW_CI_GATE_SETTING]);
  if (r) out = { value: r, source: 'repo' };
  const e = asGate(env?.[REVIEW_CI_GATE_ENV]);
  if (e) out = { value: e, source: 'env' };
  return out;
}

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out']);
const hex = (s) => (typeof s === 'string' && /^[0-9a-f]{7,64}$/i.test(s) ? s.toLowerCase() : '');
const strings = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : null);

/**
 * May a review proceed although the PR's required checks are not green?
 *
 * @param {object} o
 * @param {object} o.prChecks  the PR's CI facts:
 *   - `required`: the review gate's refused rows (`lib/review-ci-gate.mjs#reviewCiGate().affected`, `[{name, reason}]`);
 *   - `complete`: the PR's failing CI run's job list is complete (`readRunJobs().complete`);
 *   - `failed`: `[{name, tests}]` — every failed job of that run, `tests` its failing test titles
 *     (`readFailingTests`), `null` when they could not be read.
 * @param {object|null} o.mainRed  main's current red: `{status:'red', sha, failing:{jobs:string[], tests:string[]}}`
 *   (`probeMainCiRuns().failing` of the published main-red state). Anything not `red` = no inheritance possible.
 * @param {'green-only'|'ignore-inherited-main-red'} [o.setting]
 * @param {string[]} [o.summaryJobs]
 * @returns {{proceed:boolean, reason:string, inherited:Array<{job:string, tests:string[]}>,
 *   own:Array<{job:string, tests:(string[]|null), why:string}>, mainSha?:string}}
 */
export function ciGateForReview({ prChecks, mainRed, setting = REVIEW_CI_GATE_DEFAULT, summaryJobs = MAIN_CI_RED_DEFAULTS.mainCiRedSummaryJobs } = {}) {
  const wait = (reason, own = [], inherited = []) => ({ proceed: false, reason, inherited, own });
  if (asGate(setting) !== 'ignore-inherited-main-red') return wait('setting-green-only');
  if (mainRed?.status !== 'red') return wait('main-not-red');
  const mainSha = hex(mainRed.sha);
  const mainJobs = strings(mainRed.failing?.jobs);
  const mainTests = strings(mainRed.failing?.tests);
  if (!mainSha || !mainJobs?.length || !mainTests) return wait('main-red-unknown');

  // Every required check the review gate refused must be a COMPLETED failure: pending, missing, malformed, a stale
  // head, or the review-gate itself is not something main's red can explain.
  const required = Array.isArray(prChecks?.required) ? prChecks.required : null;
  if (!required?.length) return wait('pr-ci-unknown');
  const notFailed = required.filter((r) => !FAILED_CONCLUSIONS.has(String(r?.reason ?? '').toLowerCase()) || r?.name === 'review-gate');
  if (notFailed.length) return wait('pr-ci-incomplete', notFailed.map((r) => ({ job: String(r?.name ?? '?'), tests: null, why: `required check ${r?.reason ?? 'unknown'}` })));

  if (prChecks?.complete !== true || !Array.isArray(prChecks?.failed)) return wait('pr-ci-unknown');
  const summary = new Set((summaryJobs || []).map(String));
  const jobs = prChecks.failed.filter((j) => j && typeof j.name === 'string' && !summary.has(j.name));
  // A required check failed but no shard job did: nothing to compare (fail closed).
  if (!jobs.length) return wait('pr-ci-unknown');

  const mainJobSet = new Set(mainJobs);
  const mainTestSet = new Set(mainTests);
  const inherited = [];
  const own = [];
  for (const j of jobs) {
    const tests = strings(j.tests);
    if (!mainJobSet.has(j.name)) own.push({ job: j.name, tests, why: 'job is not failing on main' });
    else if (tests === null) own.push({ job: j.name, tests: null, why: 'failing tests unreadable' });
    else if (!tests.length) own.push({ job: j.name, tests, why: 'no failing test named (cannot prove it is main\'s)' });
    else {
      const extra = tests.filter((t) => !mainTestSet.has(t));
      if (extra.length) own.push({ job: j.name, tests: extra, why: 'test is not failing on main' });
      else inherited.push({ job: j.name, tests });
    }
  }
  if (own.length) return { ...wait('own-failure', own, inherited), mainSha };
  return { proceed: true, reason: 'inherited-main-red', inherited, own: [], mainSha };
}

/** The log line for a review that proceeds on inherited red. PURE. */
export function inheritedProceedWhy(gate) {
  const what = gate.inherited.map((j) => `${j.job}: ${j.tests.join('; ')}`).join(' | ');
  return `proceeding: CI failures inherited from main red @${String(gate.mainSha).slice(0, 9)} (${what})`;
}
