import { prioritizeMainFix as prioritizeCardsTest } from '../merge-queue-hook.mjs';
/**
 * @file scripts/lib/__tests__/merge-queue-hook.replay.test.mjs
 * @description The drain's merge-queue hook (card xs1hdl7) replayed on 2026-10-09's real red-main sequence, with
 *   the operator-chosen settings file (scripts/settings/merge-queue.json: disjoint main moves allowed, 30 min).
 *
 * Real data (web-everything/web-everything, read from GitHub + git):
 *   - #4453 merged 10:15:50Z. Its `test` pass: 10:00:55Z on head 55a4d105 (15 min old). Its base d94901c2 was 11
 *     commits behind main a39c6702; main moved on 5 backlog files, none of #4453's 9 files.
 *   - #4547 merged 11:23:30Z. Its `test` pass: 09:15:14Z on head 028cf083 (128 min old). Its base 7fd484e3 was 81
 *     commits behind main d1462678 (which already held #4453); main moved on 45 files, none of #4547's 71 files.
 *     Main went red at 11:44Z (07:44 ET): the two were green alone and broke together.
 *   The hook lets #4453 merge and refreshes #4547 instead of merging it — under the middle-ground mode even with a
 *   5-min-old pass, because main gained #4453's code since #4547's base.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { readApprovedHumanSurfaceHold, refreshApprovedHeadChecked, resolveSkipRebaseApprovedHumanSurface } from '../approved-human-surface-hold.mjs';
import { createMqLiveReader } from '../drain-queue-safety.mjs';
import { assertCapability } from '../repo-profile.mjs';
import { SETTINGS_DIR } from '../settings-files.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadMergeQueueSettings, hookEnabled, readMergeFreshnessFacts, decideMergeQueueAction, requiredCheckFact,
  prioritizeMainFix, isNonCodePath, mainGainedCode, readRefreshed, recordRefreshed, refreshStalePr, couplePinExcuses, MERGE_QUEUE_OFF_ENV, MERGE_QUEUE_SETTINGS_FILE_ENV,
} from '../merge-queue-hook.mjs';

const SETTINGS_FILE = JSON.parse(readFileSync(join(SETTINGS_DIR, 'merge-queue.json'), 'utf8'));
const LIVE = loadMergeQueueSettings({ file: SETTINGS_FILE, env: {} });
const REPO = 'web-everything/web-everything';
afterEach(() => vi.unstubAllEnvs());

const MAIN_MOVES_4547 = 'backlog/4362-write-guard-must-cover-the-control-clone-workspace-wev-contr.md backlog/4471-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md backlog/4472-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md backlog/4481-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md backlog/4484-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md backlog/4489-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md backlog/4492-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md backlog/4495-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md backlog/4496-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md backlog/4497-gh-throttle-logs-a-hardcoded-default-graphql-cost-per-call-i.md backlog/5478-overlay-dispatch-smoke.md backlog/5563-prevention-add-a-red-cause-value-such-as-revert-red-and-have.md backlog/5564-diagnose-unknown-prepare-result-failure-8cdad4ee9a31f1db.md backlog/5565-diagnose-unknown-prepare-result-failure-6d7d24376ce2ba58.md backlog/5566-prevention-plan-a-parameterized-test-named-rejects-every-mis.md backlog/5567-prep-review-light-pass.md backlog/5568-prevention-add-a-vitest-setup-guard-or-a-check-standards-rul.md backlog/5569-card-89-s6-migrate-unmigrate-tool-versioned-plist-template-l.md backlog/xi3s5g7-permission-change-hold-workflow-permissions-sandbox-grants-a.md scripts/__tests__/fixtures/pr4318-workflow-permissions.diff scripts/__tests__/fixtures/pr4359-sandbox-writable-roots.diff scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs scripts/__tests__/repo-scan-tests.test.mjs scripts/backlog/edge-case-classes.mjs scripts/conveyor/__tests__/prep-review.test.mjs scripts/conveyor/prep-review-io.mjs scripts/conveyor/prep-review.mjs scripts/lib/__tests__/daemon-load-overlay.test.mjs scripts/lib/__tests__/daemon-version-migrate.test.mjs scripts/lib/__tests__/permission-change.test.mjs scripts/lib/__tests__/review-escalation.test.mjs scripts/lib/__tests__/review-policy.conformance.test.mjs scripts/lib/daemon-load-overlay.mjs scripts/lib/daemon-version-migrate.mjs scripts/lib/daemon-version-runtime.mjs scripts/lib/daemon-version.mjs scripts/lib/permission-change.mjs scripts/lib/repo-scan-tests.mjs scripts/lib/review-core.mjs scripts/lib/review-escalation.mjs scripts/lib/review-policy.contract.json scripts/merge-ai-prs.mjs scripts/workflows/review-parked-prs.mjs skills-src/conveyor/launchd/com.we.health-watch.plist.example skills-src/conveyor/review-daemon.mjs'.split(' ');
const MAIN_MOVES_4453 = ['backlog/4489-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md', 'backlog/4492-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md', 'backlog/4495-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md', 'backlog/4496-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md', 'backlog/5566-prevention-plan-a-parameterized-test-named-rejects-every-mis.md'];
const FILES_4453 = ['backlog/x5f2daz-prep-review-light-pass.md', 'scripts/backlog/edge-case-classes.mjs', 'scripts/conveyor/__tests__/prep-review.test.mjs', 'scripts/conveyor/prep-review-io.mjs', 'scripts/conveyor/prep-review.mjs', 'scripts/lib/__tests__/review-escalation.test.mjs', 'scripts/lib/review-escalation.mjs', 'scripts/merge-ai-prs.mjs', 'skills-src/conveyor/review-daemon.mjs'];
const FILES_4547 = '.github/workflows/live-tests.yml backlog/xcu4cqf-hermetic-tests-by-default.md package.json scripts/__tests__/bootstrap-session.test.mjs scripts/__tests__/citation-gate-dedup.test.mjs scripts/__tests__/fixtures/shared-git-fixture.mjs scripts/__tests__/lane-pool-acquirable-growth-cap.test.mjs scripts/__tests__/lane-pool-acquirable.test.mjs scripts/__tests__/lane-pool-acquire-base.test.mjs scripts/__tests__/lane-pool-acquire-growth.test.mjs scripts/__tests__/lane-pool-acquire-refused-lease.test.mjs scripts/__tests__/lane-pool-acquire-wait-ms.test.mjs scripts/__tests__/lane-pool-cross-pool.test.mjs scripts/__tests__/lane-pool-history-ledger.test.mjs scripts/__tests__/lane-pool-hold-rule.test.mjs scripts/__tests__/lane-pool-item-map.test.mjs scripts/__tests__/lane-pool-reap-on-acquire.test.mjs scripts/__tests__/lane-pool-reap-on-list-acquirable.test.mjs scripts/__tests__/lane-pool-refresh-guard.test.mjs scripts/__tests__/lane-pool-release-item-map.test.mjs scripts/__tests__/lane-pool-release-owner-session-scope.test.mjs scripts/__tests__/lane-pool-release-ownership.test.mjs scripts/__tests__/lane-pool-reserve.test.mjs scripts/__tests__/lane-pool-stale-reclaim-race.test.mjs scripts/__tests__/lane-pool-trim.test.mjs scripts/__tests__/merge-ai-prs-stranded-sweep-wiring.test.mjs scripts/__tests__/review-set-label.approval-prevention-filing.test.mjs scripts/__tests__/review-set-label.test.mjs scripts/__tests__/stdout-flush.test.mjs scripts/conveyor/__tests__/build-delivery-evidence.test.mjs scripts/conveyor/__tests__/dispatcher-fixture-harness.test.mjs scripts/conveyor/__tests__/scope-bloat.test.mjs scripts/conveyor/soak/breaks/conflicting-head-missing-checks-refused.mjs scripts/hermetic-test-baseline.json scripts/hermetic-tests.settings.json scripts/lib/__tests__/dispatch-bg-isolation.test.mjs scripts/lib/__tests__/gh-throttle.fidelity.test.mjs scripts/lib/__tests__/hermetic-test-scan.test.mjs scripts/lib/__tests__/hermetic-tests.test.mjs scripts/lib/__tests__/judge-spawn.test.mjs scripts/lib/__tests__/pr-snapshot.test.mjs scripts/lib/__tests__/standards-sections.test.mjs scripts/lib/__tests__/test-cache-shadow.test.mjs scripts/lib/hermetic-git-overlay.mjs scripts/lib/hermetic-test-scan.mjs scripts/lib/hermetic-tests-vitest.mjs scripts/lib/hermetic-tests.mjs scripts/lib/test-tmp-root.mjs scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs scripts/operations/__tests__/codex-delivery-provider-sandbox-guards.test.mjs scripts/operations/__tests__/deliver-item-wrapper.test.mjs scripts/operations/__tests__/dispatch-lane-defaults.test.mjs scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs scripts/operations/__tests__/dispatch-lane.test.mjs scripts/operations/__tests__/health-respond.test.mjs scripts/operations/__tests__/operator-queue-health.test.mjs scripts/operations/__tests__/perf-snapshot.test.mjs scripts/operations/__tests__/pr-status.test.mjs scripts/operations/__tests__/review-prep-io.test.mjs scripts/operations/__tests__/run.test.mjs scripts/operations/__tests__/runner-activity-io.test.mjs scripts/operations/__tests__/stale-state-io.test.mjs scripts/operations/__tests__/telemetry-summary.test.mjs scripts/readiness/__tests__/conveyor-state.test.mjs scripts/readiness/__tests__/scope-lease-collect-per-lane-bounded-spawn.test.mjs scripts/test-cache/__tests__/trace-reporter.test.mjs vitest.config.ts vitest.integration.config.ts vitest.live.config.ts vitest.setup.ts vitest.soak.config.ts'.split(' '); // 71 files, none touched by main's moves

const SEQ = {
  4453: { head: '55a4d105412b368cb97f55866a7ee761715eb2c6', base: 'd94901c295a89f3bc92cc2377a7211bc9cf1f3c0', tip: 'a39c670284815109bb0948eb00f2c588a739a322',
    ahead: 11, mainFiles: MAIN_MOVES_4453, files: FILES_4453, completed: '2026-10-09T10:00:55Z', started: '2026-10-09T09:55:00Z', run: '37914007895', mergedAt: '2026-10-09T10:15:50Z' },
  4547: { head: '028cf08342fd35c1aa9217ad63ab97ca7a38e25f', base: '7fd484e323b86e5fd17c5c5853c1cb7c5b1d8244', tip: 'd14626789ac8391111515d4c84050ce5d82d54ca',
    ahead: 81, mainFiles: MAIN_MOVES_4547, files: FILES_4547, completed: '2026-10-09T09:15:14Z', started: '2026-10-09T09:14:01Z', run: '37908827763', mergedAt: '2026-10-09T11:23:30Z' },
};

/** A fake `gh` answering the three reads in GitHub's real response shapes (after the hook's own --jq). */
function fakeGh(s, num) {
  return (args) => {
    const path = args[1];
    if (path.includes('/check-runs')) {
      return JSON.stringify([{ check_runs: [{ id: s.checkId ?? 1, name: 'test', head_sha: s.head, status: 'completed', conclusion: 'success',
        started_at: s.started, completed_at: s.completed, details_url: `https://github.com/${REPO}/actions/runs/${s.run}/job/1` }] }]);
    }
    if (path.endsWith('/branches/main')) return JSON.stringify({ sha: s.tip });
    if (path.includes('/compare/')) {
      expect(path).toBe(`repos/${REPO}/compare/${s.head}...${s.tip}`);
      return JSON.stringify({ base: s.base, ahead: s.ahead, files: s.mainFiles, n: s.mainFiles.length });
    }
    if (path.startsWith(`repos/${REPO}/pulls/${num}/files`)) return JSON.stringify([s.files.map((filename) => ({ filename }))]);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
}

function replay(num, settings = LIVE) {
  const s = SEQ[num];
  const facts = readMergeFreshnessFacts({ repo: REPO, num, headSha: s.head, requiredCheck: 'test', defaultBranch: 'main', gh: fakeGh(s, num) });
  return { facts, ...decideMergeQueueAction({ key: `${REPO}#${num}`, num, facts, nowMs: Date.parse(s.mergedAt), refreshed: {}, settings }) };
}

describe('settings: the operator-chosen mode is ON in scripts/settings/merge-queue.json', () => {
  it('disjoint main moves allowed, 30 min, batch size 1, main-fix first', () => {
    expect(LIVE.errors).toEqual([]);
    expect(hookEnabled(LIVE)).toBe(true);
    expect(LIVE.freshness).toMatchObject({ enabled: true, maxAgeMinutes: 30, allowDisjointMainMoves: true, nonCodePaths: ['backlog/', 'docs/'] });
    expect(LIVE.queue).toMatchObject({ enabled: true, batchSize: 1, classOrder: ['main-fix', 'normal', 'cards'] });
  });
  it('built-in default (no file) is off = today; the env switch forces off', () => {
    expect(hookEnabled(loadMergeQueueSettings({ file: {}, env: {} }))).toBe(false);
    expect(hookEnabled(loadMergeQueueSettings({ file: SETTINGS_FILE, env: { [MERGE_QUEUE_OFF_ENV]: 'off' } }))).toBe(false);
    // hermetic: a spawned drain CLI inside a test run never reads the live file
    expect(hookEnabled(loadMergeQueueSettings({ env: { VITEST: 'true' } }))).toBe(false);
  });
  it('the env settings file arms the hook even inside a test run; an unreadable one is named, never silent', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'mqs-')), 's.json');
    writeFileSync(p, JSON.stringify(SETTINGS_FILE));
    expect(hookEnabled(loadMergeQueueSettings({ env: { VITEST: 'true', [MERGE_QUEUE_SETTINGS_FILE_ENV]: p } }))).toBe(true);
    const bad = loadMergeQueueSettings({ env: { [MERGE_QUEUE_SETTINGS_FILE_ENV]: p + '.missing' } });
    expect(hookEnabled(bad)).toBe(false);
    expect(bad.errors[0]).toMatch(/WE_MERGE_QUEUE_SETTINGS_FILE/);
  });
  it('an unbuilt batch size falls back to the queue defaults and is named', () => {
    const s = loadMergeQueueSettings({ file: { mergeQueue: { enabled: true, batchSize: 3 }, mergeFreshness: { enabled: true } }, env: {} });
    expect(s.errors).toEqual(['mergeQueue: batch-size-not-built']);
    expect(s.queue.batchSize).toBe(1);
  });
});

describe('replay 2026-10-09: #4453 then #4547 (main red 07:44 ET)', () => {
  it('#4453 (first) is merge-fresh: 15-min pass, main moved only on files it does not touch → merge', () => {
    const r = replay(4453);
    expect(r.facts.errors).toEqual([]);
    expect(r.facts.pr.baseSha).toBe(SEQ[4453].base);
    expect(r.action).toBe('merge');
  });
  it('#4547 (second) is NOT merge-fresh: main gained code AND a 128-min-old pass → refresh instead of merge', () => {
    const r = replay(4547);
    expect(r.facts.errors).toEqual([]);
    expect(r.facts.main).toMatchObject({ commitsSinceBase: 81, complete: true });
    expect(r.facts.pr.requiredCheck).toMatchObject({ state: 'passed', runId: '37908827763' });
    expect(r.action).toBe('refresh');
    expect(r.reasons).toEqual(['main-gained-code', 'base-behind-main', 'pass-too-old']);
  });
  it('MIDDLE GROUND: #4547 is refreshed even with a 5-min-old pass, because main gained #4453\'s code', () => {
    const s = { ...SEQ[4547], completed: new Date(Date.parse(SEQ[4547].mergedAt) - 5 * 60_000).toISOString() };
    const facts = readMergeFreshnessFacts({ repo: REPO, num: 4547, headSha: s.head, gh: fakeGh(s, 4547) });
    expect(mainGainedCode(facts.main, LIVE.freshness.nonCodePaths)).toBe(true); // scripts/merge-ai-prs.mjs, prep-review…
    const r = decideMergeQueueAction({ key: `${REPO}#4547`, num: 4547, facts, nowMs: Date.parse(s.mergedAt), settings: LIVE });
    expect(r).toEqual({ action: 'refresh', reasons: ['main-gained-code', 'base-behind-main'] });
  });
  it('MIDDLE GROUND: a young pass while main moved only on backlog cards / docs still merges', () => {
    const s = { ...SEQ[4453] }; // main moved on 5 backlog cards only
    const facts = readMergeFreshnessFacts({ repo: REPO, num: 4453, headSha: s.head, gh: fakeGh(s, 4453) });
    expect(mainGainedCode(facts.main, LIVE.freshness.nonCodePaths)).toBe(false);
    expect(decideMergeQueueAction({ key: 'k', num: 4453, facts, nowMs: Date.parse(s.mergedAt), settings: LIVE }).action).toBe('merge');
  });
  it('non-code paths: prefixes and exact paths; skills-src/.github/scripts are code', () => {
    expect(isNonCodePath('backlog/x.md')).toBe(true);
    expect(isNonCodePath('docs/agent/a.md')).toBe(true);
    for (const f of ['scripts/a.mjs', 'skills-src/x/SKILL.md', '.github/workflows/t.yml', 'package.json', 'AGENTS.md']) expect(isNonCodePath(f)).toBe(false);
    expect(isNonCodePath('AGENTS.md', ['AGENTS.md'])).toBe(true);
    expect(loadMergeQueueSettings({ file: { mergeFreshness: { nonCodePaths: 'docs/' } }, env: {} }).errors).toEqual(['mergeFreshness: nonCodePaths must be a list of non-empty path strings']);
  });
  it('with the rule off (today), #4547 merged — the incident', () => {
    expect(replay(4547, loadMergeQueueSettings({ file: {}, env: {} })).action).toBe('merge');
  });
  it('strict mode (no disjoint moves) also refreshes #4547, for both reasons', () => {
    const strict = loadMergeQueueSettings({ file: { ...SETTINGS_FILE, mergeFreshness: { ...SETTINGS_FILE.mergeFreshness, allowDisjointMainMoves: false } }, env: {} });
    expect(replay(4547, strict).reasons).toEqual(['base-behind-main', 'pass-too-old']);
  });
  it('once per head: a head already refreshed waits instead of refreshing again', () => {
    const s = SEQ[4547];
    const facts = readMergeFreshnessFacts({ repo: REPO, num: 4547, headSha: s.head, gh: fakeGh(s, 4547) });
    const key = `${REPO}#4547`;
    const r = decideMergeQueueAction({ key, num: 4547, facts, nowMs: Date.parse(s.mergedAt), refreshed: passRecord(key, s.head, facts), settings: LIVE });
    expect(r).toEqual({ action: 'wait', reasons: ['refresh-already-requested'] });
  });
});

/** The durable record `recordRefreshed` writes for a refresh requested against `facts`' pass (shape under test). */
function passRecord(key, head, facts, atMs = Date.parse(SEQ[4547].mergedAt)) {
  const dir = mkdtempSync(join(tmpdir(), 'mqh-rec-'));
  const p = join(dir, 'refreshed.json');
  recordRefreshed(p, key, head, { pass: facts.pr.requiredCheck, nowMs: atMs });
  return readRefreshed(p);
}

// Review of #4619: a successful `gh run rerun` keeps the same head, and the old once-per-head record (key → head) then
// answered `wait` for that head FOREVER — once the new pass aged out, or main gained code, the PR was skipped on every
// pass and never refreshed again. The record now names the pass it was requested against and lapses when a newer pass
// exists (or after the freshness window), so a rerun that completed can be followed by another refresh.
describe('a rerun on an unchanged head does not strand it (review of #4619)', () => {
  const key = `${REPO}#4547`;
  const base = SEQ[4547];
  const factsOf = (s) => readMergeFreshnessFacts({ repo: REPO, num: 4547, headSha: s.head, gh: fakeGh(s, 4547) });
  const at = (s, minAfterPass) => Date.parse(s.completed) + minAfterPass * 60_000;
  // P1: the stale pass the rerun was requested against; P2: the pass the rerun produced (new check-run id, same head, same run id).
  const p1 = { ...base, checkId: 1 };
  const p2 = { ...base, checkId: 2, completed: '2026-10-09T11:30:00Z', started: '2026-10-09T11:25:00Z' };

  it('right after the rerun (the old pass is still the latest) the head waits — no second rerun', () => {
    const record = passRecord(key, p1.head, factsOf(p1), at(p1, 130));
    const r = decideMergeQueueAction({ key, num: 4547, facts: factsOf(p1), nowMs: at(p1, 131), refreshed: record, settings: LIVE });
    expect(r).toEqual({ action: 'wait', reasons: ['refresh-already-requested'] });
  });
  it('the rerun finished and its new pass has since aged past the window → refresh again, not wait', () => {
    const record = passRecord(key, p1.head, factsOf(p1), at(p1, 130));
    const r = decideMergeQueueAction({ key, num: 4547, facts: factsOf(p2), nowMs: Date.parse(p2.completed) + 45 * 60_000, refreshed: record, settings: LIVE });
    expect(r.action).toBe('refresh');
    expect(r.reasons).toContain('pass-too-old');
  });
  it('the rerun finished, then main gained code before the PR landed → refresh again (rebase), not wait', () => {
    const record = passRecord(key, p1.head, factsOf(p1), at(p1, 130));
    const r = decideMergeQueueAction({ key, num: 4547, facts: factsOf(p2), nowMs: Date.parse(p2.completed) + 2 * 60_000, refreshed: record, settings: LIVE });
    expect(r.action).toBe('refresh');
    expect(r.reasons).toContain('main-gained-code');
  });
  it('a request whose rerun never produced a new pass lapses after the freshness window', () => {
    const record = passRecord(key, p1.head, factsOf(p1), at(p1, 130));
    const r = decideMergeQueueAction({ key, num: 4547, facts: factsOf(p1), nowMs: at(p1, 130 + LIVE.freshness.maxAgeMinutes + 1), refreshed: record, settings: LIVE });
    expect(r.action).toBe('refresh');
  });
  it('a record for another head, or a legacy key → head string, never blocks a refresh', () => {
    const facts = factsOf(p1);
    const nowMs = at(p1, 131);
    const other = passRecord(key, 'some-older-head', facts, at(p1, 130));
    expect(decideMergeQueueAction({ key, num: 4547, facts, nowMs, refreshed: other, settings: LIVE }).action).toBe('refresh');
    expect(decideMergeQueueAction({ key, num: 4547, facts, nowMs, refreshed: { [key]: p1.head }, settings: LIVE }).action).toBe('refresh');
  });
  it('the record carries the pass identity (head, check-run id, completion time) and the request time', () => {
    const facts = factsOf(p1);
    const record = passRecord(key, p1.head, facts, 1234);
    expect(record[key]).toEqual({ head: p1.head, checkRunId: 1, completedAtMs: Date.parse(p1.completed), atMs: 1234 });
  });
});

describe('fail closed on missing facts', () => {
  it('a failed read refuses the merge (never "fresh")', () => {
    const facts = readMergeFreshnessFacts({ repo: REPO, num: 1, headSha: 'abc', gh: () => { throw new Error('gh down'); } });
    expect(facts.errors.length).toBe(3);
    expect(decideMergeQueueAction({ key: 'k', num: 1, facts, nowMs: Date.now(), settings: LIVE })).toEqual({ action: 'refuse', reasons: ['facts-incomplete'] });
  });
  it('a capped compare (300 files) is incomplete', () => {
    const s = { ...SEQ[4547], mainFiles: Array.from({ length: 300 }, (_, i) => `x${i}`) };
    const facts = readMergeFreshnessFacts({ repo: REPO, num: 4547, headSha: s.head, gh: fakeGh(s, 4547) });
    expect(facts.main.complete).toBe(false);
  });
  it('a check run on another head does not count', () => {
    expect(requiredCheckFact([{ head_sha: 'other', status: 'completed', conclusion: 'success' }], 'mine').state).toBe('missing');
  });
  it('the newest run wins (a re-run pending supersedes an old pass)', () => {
    const f = requiredCheckFact([
      { id: 1, head_sha: 'h', status: 'completed', conclusion: 'success', started_at: '2026-10-09T09:00:00Z', completed_at: '2026-10-09T09:05:00Z' },
      { id: 2, head_sha: 'h', status: 'in_progress', conclusion: null, started_at: '2026-10-09T10:00:00Z' },
    ], 'h');
    expect(f.state).toBe('pending');
  });
});

// Review of #4619 (security lens): the fail-closed guarantee was pinned only when ALL reads fail. Each fact is nulled out
// on its own here, on a PR that WOULD merge when every read works (young pass, main moved only on backlog cards).
describe('fail closed: no single missing fact can turn into a merge (review of #4619)', () => {
  const s = SEQ[4453];
  const ok = fakeGh(s, 4453);
  const decide = (gh, partial = {}) => {
    const facts = readMergeFreshnessFacts({ repo: REPO, num: 4453, headSha: s.head, gh });
    Object.assign(facts.pr, partial.pr); Object.assign(facts.main, partial.main);
    return decideMergeQueueAction({ key: 'k', num: 4453, facts, nowMs: Date.parse(s.mergedAt), settings: LIVE });
  };
  it('control: with every read working this PR merges', () => {
    expect(decide(ok).action).toBe('merge');
  });
  it.each([
    ['check-runs read fails', (args) => { if (args[1].includes('/check-runs')) throw new Error('boom'); return ok(args); }],
    ['branch tip read fails', (args) => { if (args[1].endsWith('/branches/main')) throw new Error('boom'); return ok(args); }],
    ['compare read fails', (args) => { if (args[1].includes('/compare/')) throw new Error('boom'); return ok(args); }],
    ['PR files read fails', (args) => { if (args[1].includes('/pulls/')) throw new Error('boom'); return ok(args); }],
    ['check-runs reply is empty', (args) => (args[1].includes('/check-runs') ? '' : ok(args))],
    ['compare reply is not JSON', (args) => (args[1].includes('/compare/') ? 'not json' : ok(args))],
  ])('%s → refuse, never merge', (_name, gh) => {
    const r = decide(gh);
    expect(r.action).toBe('refuse');
    expect(r.reasons).toEqual(['facts-incomplete']);
  });
  it.each([
    ['compare is capped (≥300 files)', { main: { complete: false } }],
    ['the PR base is unknown', { pr: { baseSha: null } }],
    ['the main tip is unknown', { main: { tipSha: null } }],
    ['the PR file list is truncated', { pr: { filesComplete: false } }],
    ['the pass has no completion time', { pr: { requiredCheck: { state: 'passed', headSha: s.head, completedAtMs: null, runId: '1', checkRunId: 1 } } }],
  ])('%s → refuse, never merge', (_name, partial) => {
    expect(decide(ok, partial).action).toBe('refuse');
  });
});

describe('couple pin: a carrier the pre-check cleared is not split by its pass aging out (review of #4619)', () => {
  const W = 30 * 60_000;
  const pin = { head: 'H', tip: 'T', atMs: 1_000_000 };
  const stale = { headSha: 'H', mainTip: 'T', action: 'refresh', reasons: ['pass-too-old'], nowMs: 1_000_000 + 60_000, windowMs: W };
  it('same head, same main tip, only the pass aged out → the pre-check verdict stands', () => {
    expect(couplePinExcuses(pin, stale)).toBe(true);
  });
  it('time-boxed: a long gap between the pre-check and the carrier\'s turn is not excused', () => {
    expect(couplePinExcuses(pin, { ...stale, nowMs: pin.atMs + W })).toBe(true);
    expect(couplePinExcuses(pin, { ...stale, nowMs: pin.atMs + W + 1 })).toBe(false);
  });
  it.each([
    ['a pin stamped in the future (clock skew / tampered)', { ...pin, atMs: stale.nowMs + 1 }, stale],
    ['a pin with no timestamp', { head: 'H', tip: 'T' }, stale],
    ['no clock given', pin, { ...stale, nowMs: undefined }],
    ['no pin (the carrier was never pre-checked)', null, stale],
    ['the carrier head moved', pin, { ...stale, headSha: 'H2' }],
    ['main moved (a WE merge landed in between)', pin, { ...stale, mainTip: 'T2' }],
    ['main tip unreadable', pin, { ...stale, mainTip: null }],
    ['main gained code as well', pin, { ...stale, reasons: ['main-gained-code', 'base-behind-main', 'pass-too-old'] }],
    ['the pass is not on the head', pin, { ...stale, reasons: ['pass-not-on-head'] }],
    ['the rule says wait/refuse, not refresh', pin, { ...stale, action: 'refuse', reasons: ['facts-incomplete'] }],
    ['no reasons given', pin, { ...stale, reasons: [] }],
  ])('%s → judged afresh, never excused', (_name, p, args) => {
    expect(couplePinExcuses(p, args)).toBe(false);
  });
});

describe('main-fix goes first; couple halves never move', () => {
  const list = [{ num: 1, repo: null }, { num: 2, repo: null }, { num: 3, repo: null }];
  // The record main-ci-red-core.mjs#planPriority really publishes: the constellation KEY ('we'), not a slug, plus every fix PR.
  const record = { repo: 'we', pr: 3, prs: [3], firstRedSha: 'abc', reason: 'owns the red-main fix', setAt: 1, expiresAt: 2 };
  const keyOf = (c) => (c.repo == null ? 'we' : c.repo === 'frontier-ui/frontierui' ? 'fui' : c.repo); // the drain's repoKeyOfVerdict
  it('moves the published main-fix PR to the front, stable otherwise', () => {
    expect(prioritizeMainFix(list, { mainFix: record, queueSettings: LIVE.queue }).map((c) => c.num)).toEqual([3, 1, 2]);
  });
  it('matches the real record against slug-repo candidates through the drain\'s repo key (review of #4619)', () => {
    const mixed = [{ num: 1, repo: 'frontier-ui/frontierui' }, { num: 3, repo: 'frontier-ui/frontierui' }, { num: 3, repo: null }, { num: 2, repo: null }];
    // PR 3 of the WE repo (null = the local clone) goes first; FUI's own #3 is a different PR and stays put.
    expect(prioritizeMainFix(mixed, { mainFix: record, queueSettings: LIVE.queue, repoKeyOf: keyOf }).map((c) => `${c.repo ?? 'we'}#${c.num}`))
      .toEqual(['we#3', 'frontier-ui/frontierui#1', 'frontier-ui/frontierui#3', 'we#2']);
    // a record for another repo's PR 3 does not pull WE's #3 forward
    expect(prioritizeMainFix(list, { mainFix: { ...record, repo: 'fui' }, queueSettings: LIVE.queue, repoKeyOf: keyOf }).map((c) => c.num)).toEqual([1, 2, 3]);
  });
  it('every PR in `prs` is a fix and goes first (the red window may have several), in their existing order', () => {
    expect(prioritizeMainFix(list, { mainFix: { ...record, pr: 3, prs: [3, 2] }, queueSettings: LIVE.queue }).map((c) => c.num)).toEqual([2, 3, 1]);
  });
  it('off, no record, or a couple half → unchanged', () => {
    expect(prioritizeMainFix(list, { mainFix: { pr: 3 }, queueSettings: { enabled: false } })).toBe(list);
    expect(prioritizeMainFix(list, { mainFix: null, queueSettings: LIVE.queue })).toBe(list);
    expect(prioritizeMainFix(list, { mainFix: record, queueSettings: LIVE.queue, isCoupleHalf: (c) => c.num === 3 }).map((c) => c.num)).toEqual([1, 2, 3]);
  });
});

describe('R761 step 0 — fail-open guards', () => {
  // Like drain-queue-safety.test.mjs, execute the actual CLI closures with hermetic IO.
  // Keep the real readers and refresh helper: injecting readHold/readRunId would miss wiring regressions.
  const productionGuards = ({ override = 'on', failure = null, queueOwns = true, settingsUnreadable = false } = {}) => {
    vi.stubEnv('WE_GH_READ_MEMO_DIR', '/fixture/stale-memo');
    const head = 'a'.repeat(40), base = 'b'.repeat(40);
    const calls = [], warnings = [], rebases = [], reruns = [];
    const candidate = { num: 7, repo: REPO, headSha: head };
    const dependencies = {
      assertCapability,
      approvedHeadSetting: resolveSkipRebaseApprovedHumanSurface({
        env: { WE_MERGE_QUEUE_SKIP_REBASE_APPROVED_HUMAN_SURFACE: override },
        readFile: () => {
          if (settingsUnreadable) throw Error('settings unavailable');
          return JSON.stringify({ mergeQueue: { skipRebaseApprovedHumanSurface: 'off' } });
        },
      }),
      mergeStrategy: { queueOwnsFreshness: () => queueOwns }, isLocalRepo: () => true,
      siblingCloneDir: () => null, localSlug: REPO, REQUIRED: 'test', defaultBranchOf: () => 'main',
      AS_JSON: false, repoTag: () => '',
      process: { cwd: () => '/fixture', stderr: { write: message => warnings.push(message) } },
      readApprovedHumanSurfaceHold, refreshApprovedHeadChecked, readMergeFreshnessFacts, refreshStalePr, createMqLiveReader,
      readGh(args, options) {
        calls.push({ args, options });
        if (args[0] === 'pr') {
          if (failure === 'approval') throw Error('approval unavailable');
          return JSON.stringify({ headRefOid: head, labels: ['review:accepted'], mergeable: 'MERGEABLE' });
        }
        if (args.some(a => /issues\/7\/comments$/.test(a))) {
          if (failure === 'comments') throw Error('comments unavailable');
          return `<!-- reviewed-sha: ${head} -->\\n<!-- cleared-human: operator -->\t2026-11-14T00:00:00Z\tchalbert\tIC_fixture`;
        }
        if (args[1] === 'graphql') {
          if (failure === 'comment-count-read') throw Error('comment count unavailable');
          return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: failure === 'comment-count' ? 2 : 1 } } } } });
        }
        if (args[1].includes('/check-runs')) {
          if (failure === 'run') throw Error('run unavailable');
          if (failure === 'run-malformed') return '{}';
          return JSON.stringify([{ check_runs: [{ id: 1, name: 'test', head_sha: head, status: 'completed', conclusion: 'success',
            completed_at: '2026-11-14T00:00:00Z', details_url: 'https://github.com/o/r/actions/runs/99/job/1' }] }]);
        }
        if (args[1].includes('/branches/')) return JSON.stringify({ sha: base });
        if (args[1].includes('/compare/')) return JSON.stringify({ base, ahead: 0, files: [], n: 0 });
        if (args[1].includes('/files')) return JSON.stringify([[{ filename: '.github/workflows/test.yml' }]]);
        throw Error(`unexpected gh: ${args.join(' ')}`);
      },
      execFileSync(_file, args) {
        if (failure === 'tree') throw Error('tree unavailable');
        if (args[0] === 'merge-base') return base;
        if (args[0] === 'ls-tree') return '';
        if (args[0] === 'diff') return args.includes('--name-only') ? '.github/workflows/test.yml\0' : '';
        throw Error(`unexpected git: ${args.join(' ')}`);
      },
    };
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../merge-ai-prs.mjs'), 'utf8');
    const holdStart = source.indexOf('  const approvedHeadHold = ');
    const holdEnd = source.indexOf('  const prestageSetting = ', holdStart);
    const refreshStart = source.indexOf('  const refreshApprovedHead = ');
    const refreshEnd = source.indexOf('  // #2198', refreshStart);
    expect(holdStart).toBeGreaterThan(0);
    expect(holdEnd).toBeGreaterThan(holdStart);
    expect(refreshStart).toBeGreaterThan(holdEnd);
    expect(refreshEnd).toBeGreaterThan(refreshStart);
    const guards = new Function(...Object.keys(dependencies),
      source.slice(holdStart, holdEnd) + source.slice(refreshStart, refreshEnd)
      + '\nreturn { approvedHeadHold, refreshApprovedHead };')(...Object.values(dependencies));
    const refresh = (extra = {}) => guards.refreshApprovedHead(candidate, {
      laneRef: 'lane/approved', root: '/fixture', expectedHead: head, readTip: () => head,
      refresh: (_ref, options) => { rebases.push(options); return { ok: true, action: 'rebased' }; },
      rerun: id => reruns.push(id), ...extra,
    });
    return { ...guards, candidate, refresh, calls, warnings, rebases, reruns };
  };
  it.each(['on', 'bogus'])('production wiring: %s preserves an approved head and discovers its required run', async override => {
    const p = await productionGuards({ override });
    expect(await p.refresh()).toMatchObject({ ok: true, action: 'rerun', newCommit: null });
    expect(p.reruns).toEqual(['99']);
    expect(p.rebases).toEqual([]);
    const proofReads = p.calls.filter(c => c.args[0] === 'pr' || c.args[1] === 'graphql' || c.args.includes('--paginate') && c.args.some(a => a.includes('/comments')));
    expect(proofReads).toHaveLength(3);
    for (const { options } of proofReads) {
      expect(options.env).toBeDefined();
      expect(options.env).not.toHaveProperty('WE_GH_READ_MEMO_DIR');
      expect(options.throttle.env).not.toHaveProperty('WE_GH_READ_MEMO_DIR');
    }
  });
  it.each([
    ['approval', 'approval unavailable'], ['comments', 'comments unavailable'], ['tree', 'tree unavailable'],
    ['run', 'run unavailable'], ['run-malformed', 'check-runs pages malformed'],
    ['comment-count', 'complete comments read did not match a valid GraphQL totalCount'],
    ['comment-count-read', 'comment count unavailable'],
  ])('production wiring: unreadable %s refuses without rebase or rerun', async (failure, error) => {
    const p = await productionGuards({ override: 'bogus', failure });
    expect(await p.refresh()).toMatchObject({ ok: false, action: 'proof-unreadable', error: expect.stringContaining(error) });
    expect(p.warnings.join()).toContain('not refreshing');
    expect(p.rebases).toEqual([]);
    expect(p.reruns).toEqual([]);
  });
  it('production wiring: unreadable settings refuse before any IO or mutation', async () => {
    const p = productionGuards({ override: '', settingsUnreadable: true });
    expect(await p.refresh({ runId: 99 })).toMatchObject({ ok: false, action: 'proof-unreadable' });
    expect(p.calls).toEqual([]);
    expect(p.rebases).toEqual([]);
    expect(p.reruns).toEqual([]);
  });
  it('production wiring: a supplied run does not bypass unreadable approval, and a later call retries proof', async () => {
    const p = await productionGuards({ failure: 'approval' });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await p.refresh({ runId: 99 })).toMatchObject({ ok: false, action: 'proof-unreadable' });
    }
    expect(p.calls.filter(c => c.args[0] === 'pr')).toHaveLength(2);
    expect(p.rebases).toEqual([]);
    expect(p.reruns).toEqual([]);
  });
  it.each([{ override: 'off' }, { queueOwns: false }])('production wiring: the legacy branch retains PR identity (%j)', async mode => {
    const p = await productionGuards(mode);
    expect(await p.refresh()).toMatchObject({ ok: true, action: 'rebased' });
    expect(p.calls).toEqual([]);
    expect(p.rebases).toEqual([{ root: '/fixture', prNumber: 7, repo: REPO }]);
    expect(p.reruns).toEqual([]);
  });
  it('1: refreshStalePr without an integer prNumber refuses and never refreshes', async () => {
    for (const bad of [undefined, null, '7', 1.5, NaN]) {
      let called = false;
      const out = await refreshStalePr({ laneRef: 'lane/x', prNumber: bad, refresh: () => { called = true; return { ok: true, action: 'rebased' }; } });
      expect(out).toMatchObject({ ok: false, action: 'unverified-pr' });
      expect(called).toBe(false);
    }
  });
  it('2: the refresh receives {prNumber, repo}; a fork PR is not rebased and an unreadable fork check defers', async () => {
    const { refreshOntoMain } = await import('../../conveyor/ci-red-recovery-watch.mjs');
    const seen = [];
    await refreshStalePr({ laneRef: 'lane/x', prNumber: 9, repo: 'o/r', root: '/r', refresh: (_ref, o) => { seen.push(o); return { ok: true, action: 'rebased' }; } });
    expect(seen[0]).toMatchObject({ prNumber: 9, repo: 'o/r', root: '/r' });
    let rebased = false;
    const rebase = () => { rebased = true; return { action: 'rebased' }; };
    expect(refreshOntoMain('lane/x', { prNumber: 9, repo: 'o/r', rebase, readIsCrossRepository: () => true })).toMatchObject({ ok: false });
    expect(refreshOntoMain('lane/x', { prNumber: 9, repo: 'o/r', rebase, readIsCrossRepository: () => { throw new Error('unreadable'); } })).toMatchObject({ ok: false });
    expect(rebased).toBe(false);
  });
  it('3+4: unreadable approval proof or run id refuses proof-unreadable: no rebase, no rerun', async () => {
    const { refreshApprovedHeadChecked } = await import('../approved-human-surface-hold.mjs');
    let rebased = 0; const reruns = [];
    const base = { options: { laneRef: 'lane/x', expectedHead: 'h', readTip: () => 'h', rerun: (id) => reruns.push(id), refresh: () => { rebased++; return { ok: true, action: 'rebased' }; } },
      prNumber: 7, repo: 'o/r', refresh: refreshStalePr };
    const proof = await refreshApprovedHeadChecked({ ...base, readHold: () => { throw new Error('proof unreadable'); }, readRunId: () => 5 });
    const run = await refreshApprovedHeadChecked({ ...base, readHold: () => true, readRunId: () => { throw new Error('run unreadable'); } });
    expect(proof).toMatchObject({ ok: false, action: 'proof-unreadable' });
    expect(run).toMatchObject({ ok: false, action: 'proof-unreadable' });
    expect(rebased).toBe(0); expect(reruns).toEqual([]);
    const held = await refreshApprovedHeadChecked({ ...base, readHold: () => true, readRunId: () => 5 });
    expect(held).toMatchObject({ ok: true, action: 'rerun' }); expect(reruns).toEqual([5]); expect(rebased).toBe(0);
  });
  it('5d: the compare jq projection yields null files for a missing or non-array files payload', () => {
    const num = Number(Object.keys(SEQ)[0]); const s = SEQ[num]; let jq = null;
    readMergeFreshnessFacts({ repo: REPO, num, headSha: s.head, gh: (a) => { if (a[1].includes('/compare/')) jq = a[a.indexOf('--jq') + 1]; return fakeGh(s, num)(a); } });
    const run = (doc) => JSON.parse(execFileSync('jq', ['-c', jq], { input: JSON.stringify(doc), encoding: 'utf8' }));
    expect(run({ merge_base_commit: { sha: 'b' }, ahead_by: 1, files: {} }).files).toBeNull();
    expect(run({ merge_base_commit: { sha: 'b' }, ahead_by: 1 }).files).toBeNull();
    expect(run({ merge_base_commit: { sha: 'b' }, ahead_by: 1, files: [{ filename: 'a' }] }).files).toEqual(['a']);
  });
  it('5b: an empty pages list (no page read) is incomplete for check-runs and PR files', () => {
    const num = Number(Object.keys(SEQ)[0]); const s = SEQ[num]; const good = fakeGh(s, num);
    const bad = (needle) => (args) => (args[1].includes(needle) ? '[]' : good(args));
    const read = (gh) => readMergeFreshnessFacts({ repo: REPO, num, headSha: s.head, gh });
    expect(read(bad('/check-runs')).errors.join()).toMatch(/check-runs/);
    expect(read(bad(`/pulls/${num}/files`)).pr.filesComplete).toBe(false);
  });
  it('5c: an unrecognised env override resolves flagged invalid', async () => {
    const { resolveSkipRebaseApprovedHumanSurface } = await import('../approved-human-surface-hold.mjs');
    const r = resolveSkipRebaseApprovedHumanSurface({ env: { WE_MERGE_QUEUE_SKIP_REBASE_APPROVED_HUMAN_SURFACE: 'bogus' } });
    expect(r.envInvalid).toBe(true);
    expect(resolveSkipRebaseApprovedHumanSurface({ env: {} }).envInvalid).toBeUndefined();
  });
  it('5: non-array check-run / files / compare payloads leave the facts incomplete', () => {
    const s = SEQ[Number(Object.keys(SEQ)[0])]; const num = Number(Object.keys(SEQ)[0]);
    const good = fakeGh(s, num);
    const bad = (needle, reply) => (args) => (args[1].includes(needle) ? JSON.stringify(reply) : good(args));
    const read = (gh) => readMergeFreshnessFacts({ repo: REPO, num, headSha: s.head, gh });
    const runs = read(bad('/check-runs', { check_runs: [] }));
    expect(runs.errors.join()).toMatch(/check-runs/);
    expect(runs.pr.requiredCheck).toBeNull();
    expect(read(bad('/check-runs', [{ check_runs: {} }])).errors.join()).toMatch(/check-runs/);
    expect(readMergeFreshnessFacts({ repo: REPO, num, headSha: s.head, gh: (a) => (a[1].includes('/compare/') ? (expect(a.join(' ')).toContain('(.files | type) == "array"'), JSON.stringify({ base: s.base, ahead: 1, files: null, n: 0 })) : good(a)) }).main.complete).toBe(false);
    expect(read(bad(`/pulls/${num}/files`, { filename: 'a' })).pr.filesComplete).toBe(false);
    expect(read(bad(`/pulls/${num}/files`, [{ filename: 'a' }])).pr.filesComplete).toBe(false);
    expect(read(bad('/compare/', { base: s.base, ahead: 0, files: 'x', n: 0 })).main.complete).toBe(false);
  });
});

describe('refresh path', () => {
  it('rebuilds through refreshOntoMain', async () => {
    const calls = [];
    const out = await refreshStalePr({ laneRef: 'lane/x', prNumber: 7, root: '/r', refresh: (ref, o) => { calls.push([ref, o]); return { ok: true, action: 'rebased', newCommit: 'n1' }; } });
    expect(calls).toEqual([['lane/x', { root: '/r', prNumber: 7, repo: null }]]);
    expect(out).toEqual({ ok: true, action: 'rebased', newCommit: 'n1' });
  });
  it('already on the main tip (only the pass is old) → re-run the required run', async () => {
    const reruns = [];
    const out = await refreshStalePr({ laneRef: 'lane/x', prNumber: 7, runId: '42', refresh: () => ({ ok: true, action: 'current' }), rerun: (id) => reruns.push(id) });
    expect(reruns).toEqual(['42']);
    expect(out.action).toBe('rerun');
  });
  it('pinned to the judged head: a branch that moved since the judgment is never rebuilt', async () => {
    let called = false;
    const out = await refreshStalePr({ laneRef: 'lane/x', prNumber: 7, expectedHead: 'judged', readTip: () => 'pushed-since', refresh: () => { called = true; return { ok: true, action: 'rebased' }; } });
    expect(called).toBe(false);
    expect(out).toMatchObject({ ok: false, action: 'head-moved' });
    const ok = await refreshStalePr({ laneRef: 'lane/x', prNumber: 7, expectedHead: 'judged', readTip: () => 'judged', refresh: () => ({ ok: true, action: 'rebased', newCommit: 'n' }) });
    expect(ok.action).toBe('rebased');
  });
  it('a refused rebase is reported, not thrown', async () => {
    const out = await refreshStalePr({ laneRef: 'lane/x', prNumber: 7, refresh: () => ({ ok: false, action: 'skip', error: 'real conflict' }) });
    expect(out).toEqual({ ok: false, action: 'skip', error: 'real conflict' });
  });
  it('the once-per-head record persists across processes (one drain process per pass)', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'mqh-')), 'refreshed.json');
    const pass = { checkRunId: 5, completedAtMs: 1000 };
    recordRefreshed(p, 'r#1', 'h1', { pass, nowMs: 1 });
    recordRefreshed(p, 'r#1', 'h2', { pass, nowMs: 2 });
    expect(readRefreshed(p)).toEqual({ 'r#1': { head: 'h2', checkRunId: 5, completedAtMs: 1000, atMs: 2 } });
  });
});


describe('card-only candidate class resolution', () => {
  const card = num => ({ num, changedFiles: [`backlog/${num}-card.md`], filesComplete: true });
  const mixed = num => ({ num, changedFiles: [`backlog/${num}-card.md`, 'scripts/x.mjs'], filesComplete: true });
  const queueSettings = { enabled: true, classOrder: ['main-fix', 'normal', 'cards'], defaultClass: 'normal' };
  it('groups cards behind code even when there is no published main-fix', () => {
    const rows = [card(1), mixed(2), card(3), mixed(4)];
    expect(prioritizeCardsTest(rows, { queueSettings }).map(row => row.num)).toEqual([2, 4, 1, 3]);
  });
  it('resolves a card-only candidate to cards and a mixed candidate to normal', () => {
    // Reverse just these two classes to distinguish classification from an unconditional cards-last sort.
    const rows = [mixed(2), card(1)];
    expect(prioritizeCardsTest(rows, { queueSettings: { ...queueSettings, classOrder: ['main-fix', 'cards', 'normal'] } })
      .map(row => row.num)).toEqual([1, 2]);
  });
  it('keeps the published main-fix first even when it contains only cards', () => {
    const rows = [card(1), mixed(2), card(3)];
    expect(prioritizeCardsTest(rows, { queueSettings, mainFix: { repo: 'we', pr: 3 } }).map(row => row.num))
      .toEqual([3, 2, 1]);
  });
  it('leaves docs, missing and empty diff evidence in normal', () => {
    const rows = [card(1), { num: 2, changedFiles: ['docs/a.md'] }, { num: 3 }, { num: 4, changedFiles: [] }];
    expect(prioritizeCardsTest(rows, { queueSettings }).map(row => row.num)).toEqual([2, 3, 4, 1]);
  });
  it('preserves existing order when queue policy is off', () => {
    const rows = [card(1), mixed(2)];
    expect(prioritizeCardsTest(rows, { queueSettings: { ...queueSettings, enabled: false } })).toEqual(rows);
  });
});

describe('refreshStalePr rerun uses the repo REST endpoint, never `gh run`', () => {
  const base = { laneRef: 'lane/x', root: '/r', repo: 'o/r', prNumber: 7, runId: 123, refresh: () => ({ ok: true, action: 'current' }) };
  it('POSTs the run rerun endpoint directly', async () => {
    const calls = [];
    const out = await refreshStalePr({ ...base, execGh: args => { calls.push(args); return ''; } });
    expect(out).toMatchObject({ ok: true, action: 'rerun' });
    expect(calls).toEqual([['api', '-X', 'POST', 'repos/o/r/actions/runs/123/rerun']]);
  });
  it('surfaces a refused rerun without mutating the branch (no update-branch fallback)', async () => {
    const calls = [];
    const out = await refreshStalePr({ ...base, execGh: args => { calls.push(args); throw new Error('HTTP 403: run cannot be rerun'); } });
    expect(out).toMatchObject({ ok: false, action: 'rerun-failed', error: expect.stringContaining('403') });
    expect(calls).toEqual([['api', '-X', 'POST', 'repos/o/r/actions/runs/123/rerun']]);
  });
  it('triggers gate:refresh for an identified startup_failure without changing the head', async () => {
    const head = 'a'.repeat(40), calls = [];
    const out = await refreshStalePr({ ...base, expectedHead: head, readTip: () => head,
      runConclusion: 'startup_failure',
      execGh: args => {
        calls.push(args);
        if (args.at(-1).endsWith('/rerun')) throw Object.assign(new Error('gh api failed'), { stderr: 'HTTP 403: This workflow run cannot be retried' });
        return JSON.stringify(args[0] === 'pr' && args[1] === 'view' ? { labels: calls.some(call => call.includes('--add-label')) ? [{ name: 'gate:refresh' }] : [] } : { head: { sha: head } });
      } });
    expect(out).toEqual({ ok: true, state: 'confirmed', action: 'gate-refresh', newCommit: null });
    expect(calls).toEqual([
      ['api', 'repos/o/r/pulls/7'],
      ['pr', 'view', '7', '--repo', 'o/r', '--json', 'labels'],
      ['label', 'create', 'gate:refresh', '--repo', 'o/r', '--color', 'ededed', '--description', 'Refresh merge-gate after acceptance restamp'],
      ['pr', 'edit', '7', '--repo', 'o/r', '--add-label', 'gate:refresh'],
      ['pr', 'view', '7', '--repo', 'o/r', '--json', 'labels'],
      ['pr', 'edit', '7', '--repo', 'o/r', '--remove-label', 'gate:refresh'],
    ]);
  });
  it.each([null, 'failure', 'success'])('a non-gate run 403 cannot-be-retried with conclusion %s never toggles the label', async runConclusion => {
    const head = 'a'.repeat(40), calls = [];
    const out = await refreshStalePr({ ...base, runConclusion, expectedHead: head, readTip: () => head,
      execGh: args => {
        calls.push(args);
        if (args.includes('POST')) throw Object.assign(new Error('gh api failed'), { stderr: 'HTTP 403: This workflow run cannot be retried' });
        return JSON.stringify(args[0] === 'pr' && args[1] === 'view' ? { labels: calls.some(call => call.includes('--add-label')) ? [{ name: 'gate:refresh' }] : [] } : { head: { sha: head } });
      } });
    expect(out).toMatchObject({ ok: false, action: 'rerun-failed' });
    expect(calls).toEqual([['api', '-X', 'POST', 'repos/o/r/actions/runs/123/rerun']]);
  });
  it.each(['moved', 'unreadable', 'missing expected head'])('refuses label fallback with %s head evidence', async kind => {
    const head = 'a'.repeat(40), calls = [];
    const out = await refreshStalePr({ ...base, runConclusion: 'startup_failure',
      ...(kind === 'missing expected head' ? {} : { expectedHead: head, readTip: () => head }),
      execGh: args => { calls.push(args); return kind === 'unreadable' ? '{' : JSON.stringify({ head: { sha: 'b'.repeat(40) } }); } });
    expect(out).toMatchObject({ ok: false, action: 'gate-refresh-failed', error: expect.stringContaining('operator') });
    expect(calls.every(args => args[0] === 'api' && !args.includes('POST'))).toBe(true);
  });
  it('reports failed label writes instead of claiming a refresh succeeded', async () => {
    const head = 'a'.repeat(40), calls = [];
    const out = await refreshStalePr({ ...base, expectedHead: head, readTip: () => head,
      runConclusion: 'startup_failure', execGh: args => {
        calls.push(args);
        if (args[0] === 'label') throw new Error('HTTP 403: Forbidden');
        return JSON.stringify(args[0] === 'pr' && args[1] === 'view' ? { labels: calls.some(call => call.includes('--add-label')) ? [{ name: 'gate:refresh' }] : [] } : { head: { sha: head } });
      } });
    expect(out).toMatchObject({ ok: false, action: 'gate-refresh-failed', error: expect.stringContaining('operator') });
    expect(calls.filter(args => args[0] === 'label')).toHaveLength(3);
    expect(calls.some(args => args[0] === 'pr' && args[1] === 'edit')).toBe(false);
  });
  it('reports a failed rerun and never calls `gh run`', async () => {
    const calls = [];
    const out = await refreshStalePr({ ...base, execGh: args => { calls.push(args); throw new Error('HTTP 404: Not Found'); } });
    expect(out).toMatchObject({ ok: false, action: 'rerun-failed', error: expect.stringContaining('404') });
    expect(calls.every(a => a[0] === 'api')).toBe(true);
  });
  it('refuses a rerun with no repo (fail closed)', async () => {
    expect(await refreshStalePr({ ...base, repo: null, execGh: () => '' })).toMatchObject({ ok: false });
  });
});
