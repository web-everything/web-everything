/**
 * @file gate-entrypoint-integration.test.mjs — hermetic INTEGRATION test of the REAL drain entrypoint.
 *
 * WHY THIS EXISTS ALONGSIDE THE PURE SUITES. The pure tests prove `decideReviewGate`/`scoreEscalation`/
 * `classifyPr`/`hasUnclearedReviewLabel` return the right verdict for a given input. They CANNOT prove the
 * thing that actually protects `main`: that `runCli` — the real `node scripts/merge-ai-prs.mjs` entrypoint —
 * actually CONSULTS the gate before it merges. A refactor could leave every pure function perfect yet stop
 * calling one of them (or call it with the wrong signals), and no pure test would notice. This test closes
 * that gap by driving the actual CLI end-to-end.
 *
 * HOW IT STAYS HERMETIC (and CI-safe). It puts fake `gh` and `git` executables on `PATH` (a shim dir this
 * test writes), so the real `runCli` runs unmodified but every network/repo call is answered from a canned
 * PR fixture — no GitHub, no real repo, no auth. `--dry-run` means it decides but never merges; we read the
 * decision off its `--json` output (`toMerge` / `parked` / `skipped`). The fake `git diff` fails on purpose
 * so the escalation pass falls back to the (also-faked) `gh pr view --json files`, i.e. ALL escalation input
 * is controlled through the fixture. Everything lives in an OS temp dir; nothing touches the real tree.
 *
 * Under #2162/#2171/#2285/#2366 (the auto-review gate) — the entrypoint half of the gate-invariants tripwires.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'merge-ai-prs.mjs'); // the REAL entrypoint under test

// ── fake gh: answers pr list / pr view from the fixture pointed to by $GATE_FIXTURE; succeeds quietly else ──
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const fx = JSON.parse(fs.readFileSync(process.env.GATE_FIXTURE, 'utf8'));
const a = process.argv.slice(2);
const ji = a.indexOf('--json');
const fields = ji >= 0 ? String(a[ji + 1] || '') : '';
function out(o) { process.stdout.write(JSON.stringify(o)); process.exit(0); }
// Record every 'pr comment' the drain posts (only when a log path is set — dry-run runs never reach here, so the
// default JSON-reading tests are unaffected). Used by the finding-1 non-dry-run test to prove which park kinds
// get a durable skip/park comment.
if (a[0] === 'pr' && a[1] === 'comment' && process.env.GATE_COMMENT_LOG) {
  const bi = a.indexOf('--body');
  const full = String((bi >= 0 && a[bi + 1]) || '');
  fs.appendFileSync(process.env.GATE_COMMENT_LOG, JSON.stringify({ num: a[2], head: full.split('\\n')[0], body: full }) + '\\n');
  process.exit(0);
}
// A flagged PR's '--body' edit FAILS (non-zero) — models a gh write that does not land (#2820 round-4 attest-by-
// verified regression test). Label edits (--add-label/--remove-label) still succeed; only the body write fails.
if (a[0] === 'pr' && a[1] === 'edit' && a.includes('--body')) {
  const pr = fx.prs.find((p) => String(p.number) === String(a[2]));
  if (pr && pr._editBodyFail) { process.stderr.write('forced body-edit failure\\n'); process.exit(1); }
}
// #2502 — a flagged PR's merge write FAILS (non-zero), proving the FAILED (not merged) path through the real
// entrypoint records the failed-bucket headSha too. Every other PR's merge succeeds silently (falls to the catchall).
if (a[0] === 'pr' && a[1] === 'merge') {
  const pr = fx.prs.find((p) => String(p.number) === String(a[2]));
  // xvzc4v4 advisory fix — record every merge argv (only when a log path is set) so a test can assert the exact
  // --match-head-commit the drain pinned the merge to.
  if (process.env.GATE_MERGE_LOG) fs.appendFileSync(process.env.GATE_MERGE_LOG, JSON.stringify(a) + '\\n');
  // xvzc4v4 advisory fix — the merge LANDS server-side but gh still exits non-zero (a branch-delete failure or a
  // network drop after the merge response): later 'state' reads report MERGED, via a marker file by the fixture.
  if (pr && pr._mergeFailButLands) { fs.writeFileSync(process.env.GATE_FIXTURE + '.merged-' + pr.number, ''); process.stderr.write('forced post-merge gh failure\\n'); process.exit(1); }
  if (pr && pr._mergeFail) { process.stderr.write('forced merge failure\\n'); process.exit(1); }
}
if (a[0] === 'pr' && a[1] === 'list') out(fx.prs);
if (a[0] === 'pr' && a[1] === 'view') {
  const pr = fx.prs.find((p) => String(p.number) === String(a[2])) || {};
  const fieldList = fields.split(',');
  // xvzc4v4 advisory fix — the drain's pre-merge FRESH read is the one 'pr view' asking for mergeStateStatus;
  // _freshReadFail fails exactly that read, leaving every other read (the state probe, comments, …) working.
  if (pr._freshReadFail && fieldList.includes('mergeStateStatus')) { process.stderr.write('forced fresh-read failure\\n'); process.exit(1); }
  // xvzc4v4 (merge-safety review, bug 1 fix follow-up) — this used to be a chain of early-exiting ifs, each
  // calling out() (which itself process.exit(0)s) the INSTANT it matched one field. That modeled every past
  // caller correctly because each one asked for exactly one field group at a time (commits alone, body
  // alone, headRefOid,comments together, …) — but fetchFreshPrForRevalidation's new combined read
  // (number,title,body,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,labels,
  // commits — everything classifyPr needs, in ONE gh call) hit the commits check FIRST and returned an
  // object with ONLY commits — missing number — so fetchFreshPrForRevalidation read that as 'not the right
  // PR' and returned null, which revalidateForMerge (correctly, per its own fail-closed contract) then
  // refused to merge on. Every candidate aborted at revalidation, merged stayed empty, and the #2502 headSha
  // assertions failed on undefined — not a production bug, a test-double gap: a real gh answers every
  // requested field in one reply, so the shim now ACCUMULATES matching fields into one response object instead
  // of returning the first match alone, matching real gh for any field combination a caller asks for.
  const resp = {};
  if (fields.includes('commits')) resp.commits = pr._commits || [];
  if (fields.includes('files')) resp.files = pr._files || [];
  if (fields.includes('body')) resp.body = pr.body || '';
  // #2409 reviewed-SHA staleness read: return the live head plus a reviewed-sha marker comment. When the fixture's
  // _reviewedSha differs from _headRefOid the accept is STALE (re-park); no marker → gate fails open.
  // #xmnl36p — _clearedBy adds the durable --to=clear-human attribution comment the operator ceremony writes,
  // so the entrypoint test can prove the drain READS it back and announces a re-hold that overrides it.
  // #3060 — the heading is part of the fixture on purpose, not incidental. parseOperatorClearance's prose regex
  // is now anchored to the exact clear-human heading-then-attribution shape buildVerdictComment renders (a
  // caller field can never be first in the body); a fixture missing the heading would silently stop exercising
  // the real prose-clearance path this test is FOR.
  if (fields.includes('headRefOid')) {
    const cs = [];
    // #4140 — parseReviewedSha now only counts a TRUSTED author's marker (author.login: automation or the
    // operator); a real accept comment always carries one (review-set-label.mjs stamps it under whichever
    // credential ran the accept), so the fixture must too or this test would stop exercising the real path.
    if (pr._reviewedSha) cs.push({ body: '<!-- reviewed-sha: ' + pr._reviewedSha + ' -->', author: { login: 'web-everything' } });
    if (pr._clearedBy) cs.push({ body: '✅ review — \`review:human\` cleared via the sanctioned path\\n\\nCleared by ' + pr._clearedBy + ' via \`review-set-label.mjs --to=clear-human\` (#2895).' });
    // xvzc4v4 advisory fix — with no explicit _headRefOid the live head IS the tip commit (as on real GitHub);
    // a fixture sets _headRefOid to something else to model a push landing after the pass-start commits read.
    const tip = (pr._commits || [])[(pr._commits || []).length - 1];
    resp.headRefOid = pr._headRefOid || (tip && tip.oid) || '';
    resp.comments = cs;
  }
  if (fieldList.includes('state')) resp.state = (pr._state === 'MERGED' || fs.existsSync(process.env.GATE_FIXTURE + '.merged-' + pr.number)) ? 'MERGED' : 'OPEN';
  if (fieldList.includes('mergedAt')) resp.mergedAt = resp.state === 'MERGED' ? '2026-09-25T00:00:00Z' : null;
  if (fields.includes('comments') && !('comments' in resp)) resp.comments = [];
  // xvzc4v4 — the rest of what fetchFreshPrForRevalidation asks for in its one combined call, so
  // revalidateForMerge's classifyPr(freshPr, …) sees a real PR shape instead of failing closed on it.
  if (fields.includes('number')) resp.number = pr.number;
  if (fields.includes('title')) resp.title = pr.title || '';
  if (fields.includes('headRefName')) resp.headRefName = pr.headRefName;
  if (fields.includes('baseRefName')) resp.baseRefName = pr.baseRefName;
  if (fields.includes('mergeable')) resp.mergeable = pr.mergeable;
  if (fields.includes('mergeStateStatus')) resp.mergeStateStatus = pr.mergeStateStatus;
  if (fields.includes('statusCheckRollup')) resp.statusCheckRollup = pr.statusCheckRollup;
  if (fields.includes('labels')) resp.labels = pr.labels || [];
  out(resp);
}
// pr edit / pr comment / label create / api … — succeed silently (dry-run shouldn't reach the mutating ones)
process.stdout.write(''); process.exit(0);
`;

// ── fake git: canned origin slug; `diff` FAILS (forces the gh-files escalation fallback); else no-op ──
const FAKE_GIT = `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'remote' && a[1] === 'get-url') { process.stdout.write('git@github.com:web-everything/web-everything.git\\n'); process.exit(0); }
if (a[0] === 'diff') { process.exit(1); } // force computeNetDiffChangedFiles → gh 'pr view --json files' fallback
process.exit(0);
`;

let shimDir;
let workDir;

beforeAll(() => {
  shimDir = mkdtempSync(join(tmpdir(), 'gate-shim-'));
  workDir = mkdtempSync(join(tmpdir(), 'gate-work-'));
  writeFileSync(join(shimDir, 'gh'), FAKE_GH);
  writeFileSync(join(shimDir, 'git'), FAKE_GIT);
  chmodSync(join(shimDir, 'gh'), 0o755);
  chmodSync(join(shimDir, 'git'), 0o755);
});
afterAll(() => {
  for (const d of [shimDir, workDir]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

/** Run the REAL entrypoint against a canned fixture, return its parsed --json result. */
function runDrain(fixture, args) {
  const fxPath = join(workDir, `fixture-${fixture._id}.json`);
  writeFileSync(fxPath, JSON.stringify(fixture));
  const stdout = execFileSync('node', [SCRIPT, ...args, '--dry-run', '--this-repo', '--json'], {
    cwd: workDir,                                   // a clean dir — no park-state, no real repo
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, GATE_FIXTURE: fxPath },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = stdout.trim().split('\n').filter(Boolean).pop(); // the last line is the JSON result
  return JSON.parse(line);
}

/** Run the REAL entrypoint NON-dry-run (so the skip/park COMMENT paths actually fire), with the whole-process
 *  lease bypassed (`--no-drain-lease`, the documented tests/break-glass escape) and every `gh pr comment`
 *  recorded. Returns `{ result, comments }`. Used only by the finding-1 test — a merge never happens because the
 *  fixtures are all held/parked (empty `toMerge`), so the cascade is a no-op and nothing touches the real tree. */
function runDrainLive(fixture, args) {
  const fxPath = join(workDir, `fixture-${fixture._id}.json`);
  const logPath = join(workDir, `comments-${fixture._id}.log`);
  writeFileSync(fxPath, JSON.stringify(fixture));
  writeFileSync(logPath, '');
  const stdout = execFileSync('node', [SCRIPT, ...args, '--no-drain-lease', '--this-repo', '--json'], {
    cwd: workDir,
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, GATE_FIXTURE: fxPath, GATE_COMMENT_LOG: logPath },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());
  const comments = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { result, comments };
}

const nums = (arr) => (arr || []).map((x) => Number(x.num));
const GREEN = [{ name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED' }];
const AI_COMMIT = [{ authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }] }];

describe('the real drain entrypoint consults the gate before merging', () => {
  it('label-scoped drain: a gate-self PR PARKS as review:human and never lands, while a clean leaf PR would merge', () => {
    const fixture = {
      _id: 'label',
      prs: [
        { number: 101, title: 'clean leaf', body: 'a real summary', headRefName: 'lane/a', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN,
          labels: [{ name: 'ready-to-merge' }], _commits: AI_COMMIT, _files: [{ path: 'backlog/x.md', additions: 5, deletions: 1 }] },
        // #2771/#2785 — the DECLARATIVE LEASH (the roster) is what "edits the gate policy itself" now means.
        { number: 102, title: 'edits the gate policy itself', body: 'a real summary', headRefName: 'lane/b', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN,
          labels: [{ name: 'ready-to-merge' }], _commits: AI_COMMIT, _files: [{ path: 'scripts/lib/gate-config.mjs', additions: 3, deletions: 1 }] },
        // …while its DERIVATION CODE parks for the independent committee instead — the whole narrowing, proven
        // end-to-end through the REAL entrypoint rather than against the pure scorer.
        { number: 104, title: 'refactors the gate derivation code', body: 'a real summary', headRefName: 'lane/f', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN,
          labels: [{ name: 'ready-to-merge' }], _commits: AI_COMMIT, _files: [{ path: 'scripts/lib/review-escalation.mjs', additions: 3, deletions: 1 }] },
        { number: 103, title: 'leaf but already human-gated', body: 'a real summary', headRefName: 'lane/c', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN,
          labels: [{ name: 'ready-to-merge' }, { name: 'review:human' }], _commits: AI_COMMIT, _files: [{ path: 'backlog/y.md', additions: 2, deletions: 0 }] },
      ],
    };
    const r = runDrain(fixture, ['--label=ready-to-merge', '--no-reconcile-labels']);

    // the clean leaf PR is landable — the entrypoint would merge it
    expect(nums(r.toMerge)).toContain(101);

    // the gate-self PR must be PARKED as human-required, and must NOT be in the merge set — the core proof
    // that the REAL entrypoint refuses to auto-merge an edit to its own gate
    expect(nums(r.toMerge)).not.toContain(102);
    expect(nums(r.merged)).not.toContain(102);
    const p102 = r.parked.find((p) => Number(p.num) === 102);
    expect(p102).toBeTruthy();
    expect(p102.humanRequired).toBe(true);

    // #2771/#2785 — the derivation-code PR ESCALATES (it never merges unreviewed) but parks agent-reviewable
    expect(nums(r.toMerge)).not.toContain(104);
    expect(nums(r.merged)).not.toContain(104);
    const p104 = r.parked.find((p) => Number(p.num) === 104);
    expect(p104).toBeTruthy();
    expect(p104.humanRequired).toBe(false);

    // the already-human-labelled PR is held by the sticky veto too, even though its own diff is a leaf
    expect(nums(r.toMerge)).not.toContain(103);
    const p103 = r.parked.find((p) => Number(p.num) === 103);
    expect(p103).toBeTruthy();
    expect(p103.humanRequired).toBe(true);
  });

  // #2502 — the tip commit's head SHA, threaded onto every emitted result-bucket entry (not just `toMerge`),
  // proven through the REAL entrypoint so a future edit that drops the field on one bucket (parked/skipped) goes
  // red here, not just in a pure `buildDrainVerdicts` unit test. The stuck detector (plateau-app) reads this
  // field off EVERY bucket, not only the landed one, to tell a thrashing (force-pushed) PR from one just waiting.
  it('#2502: every result bucket (toMerge/parked/skipped) carries the PR tip commit\'s headSha', () => {
    const RED = [{ name: 'test', conclusion: 'FAILURE', status: 'COMPLETED' }];
    const shaCommits = (oid) => [{ authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }], oid }];
    const fixture = {
      _id: 'headsha',
      prs: [
        { number: 901, title: 'clean leaf, lands', body: 'a real summary', headRefName: 'lane/m', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN,
          labels: [{ name: 'ready-to-merge' }], _commits: shaCommits('sha-toMerge-901'), _files: [{ path: 'backlog/hs1.md', additions: 1, deletions: 0 }] },
        { number: 902, title: 'held, parks', body: 'a real summary', headRefName: 'lane/n', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN,
          labels: [{ name: 'ready-to-merge' }, { name: 'review:changes' }], _commits: shaCommits('sha-parked-902'), _files: [{ path: 'backlog/hs2.md', additions: 1, deletions: 0 }] },
        { number: 903, title: 'red CI, plain skip', body: 'a real summary', headRefName: 'lane/o', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: RED,
          labels: [{ name: 'ready-to-merge' }], _commits: shaCommits('sha-skipped-903'), _files: [{ path: 'backlog/hs3.md', additions: 1, deletions: 0 }] },
      ],
    };
    const r = runDrain(fixture, ['--label=ready-to-merge', '--no-reconcile-labels']);

    expect(r.toMerge.find((x) => Number(x.num) === 901)?.headSha).toBe('sha-toMerge-901');
    expect(r.parked.find((x) => Number(x.num) === 902)?.headSha).toBe('sha-parked-902');
    expect(r.skipped.find((x) => Number(x.num) === 903)?.headSha).toBe('sha-skipped-903');
  });

  // #2502 — the `merged`/`failed` buckets ONLY populate on a REAL (non-dry-run) merge attempt, which the
  // toMerge/parked/skipped test above never exercises (it always runs --dry-run). Proves the actual
  // `merged.push`/`failedMerges.push` call sites (scripts/merge-ai-prs.mjs, the live cascade) carry the real
  // headSha through, not just `null` — the exact gap the panel found in every hand-built pure-unit fixture.
  it('#2502: a REAL merge carries the PR tip commit\'s headSha into the merged bucket', () => {
    const shaCommits = (oid) => [{ authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }], oid }];
    const fixture = {
      _id: 'headsha-live-merge',
      prs: [
        { number: 911, title: 'clean leaf, actually merges', body: 'a real summary', headRefName: 'lane/p', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN,
          labels: [{ name: 'ready-to-merge' }], _commits: shaCommits('sha-merged-911'), _files: [{ path: 'backlog/hs4.md', additions: 1, deletions: 0 }] },
      ],
    };
    const { result } = runDrainLive(fixture, ['--label=ready-to-merge', '--no-reconcile-labels']);
    expect(result.merged.find((x) => Number(x.num) === 911)?.headSha).toBe('sha-merged-911');
  });

  // A merge FAILURE makes the real entrypoint exit non-zero (some merge failed this pass), so runDrainLive's
  // plain execFileSync throws — read the JSON off the thrown error's own captured stdout instead (child_process
  // still populates it on a non-zero exit; only a genuine spawn failure would leave it empty).
  it('#2502: a REAL merge failure carries the PR tip commit\'s headSha into the failed bucket', () => {
    const shaCommits = (oid) => [{ authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }], oid }];
    const fixture = {
      _id: 'headsha-live-fail',
      prs: [
        { number: 912, title: 'clean leaf, merge write FAILS', body: 'a real summary', headRefName: 'lane/q', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN,
          labels: [{ name: 'ready-to-merge' }], _commits: shaCommits('sha-failed-912'), _files: [{ path: 'backlog/hs5.md', additions: 1, deletions: 0 }], _mergeFail: true },
      ],
    };
    const fxPath = join(workDir, `fixture-${fixture._id}.json`);
    writeFileSync(fxPath, JSON.stringify(fixture));
    let result;
    try {
      const stdout = execFileSync('node', [SCRIPT, '--label=ready-to-merge', '--no-reconcile-labels', '--no-drain-lease', '--this-repo', '--json'], {
        cwd: workDir,
        env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, GATE_FIXTURE: fxPath },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      result = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());
    } catch (e) {
      result = JSON.parse(String(e.stdout).trim().split('\n').filter(Boolean).pop());
    }
    expect(result.failed.find((x) => Number(x.num) === 912)?.headSha).toBe('sha-failed-912');
  });

  // xvzc4v4 advisory fix — REAL-EXECUTION coverage of the pre-merge revalidation and the already-merged recovery
  // paths. The source-text tests in merge-ai-prs-merge-trace-post-confirm.test.mjs regex-match those branches;
  // they could not see that the catch branch called a `const` declared inside the sibling `try` block (a
  // ReferenceError that crashed the whole pass). These drive the real entrypoint through each branch instead.
  const shaCommitsX = (oid) => [{ authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }], oid }];
  const liveLeaf = (number, extra) => ({ number, title: `leaf ${number}`, body: 'a real summary', headRefName: `lane/x${number}`, baseRefName: 'main',
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN, labels: [{ name: 'ready-to-merge' }],
    _commits: shaCommitsX(`sha-${number}`), _files: [{ path: `backlog/x${number}.md`, additions: 1, deletions: 0 }], ...extra });
  /** Non-dry-run drain that tolerates a non-zero exit and records every `gh pr merge` argv. */
  function runDrainLiveRecordingMerges(fixture) {
    const fxPath = join(workDir, `fixture-${fixture._id}.json`);
    const mergeLog = join(workDir, `merges-${fixture._id}.log`);
    const commentLog = join(workDir, `comments-${fixture._id}.log`);
    writeFileSync(fxPath, JSON.stringify(fixture));
    writeFileSync(mergeLog, '');
    writeFileSync(commentLog, '');
    let stdout;
    try {
      stdout = execFileSync('node', [SCRIPT, '--label=ready-to-merge', '--no-reconcile-labels', '--no-drain-lease', '--this-repo', '--json'], {
        cwd: workDir,
        env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, GATE_FIXTURE: fxPath, GATE_MERGE_LOG: mergeLog, GATE_COMMENT_LOG: commentLog },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) { stdout = String(e.stdout || ''); }
    const line = stdout.trim().split('\n').filter(Boolean).pop();
    const readLog = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { result: line ? JSON.parse(line) : null, merges: readLog(mergeLog), comments: readLog(commentLog) };
  }
  /** The #2412 merge-trace comments the drain posted for PR `num`. */
  const traceCommentsFor = (comments, num) => comments.filter((c) => Number(c.num) === num && /Merge trace/.test(c.body));

  it('xvzc4v4: the merge is pinned (--match-head-commit) to the head SHA the pass-start decision judged', () => {
    const { result, merges } = runDrainLiveRecordingMerges({ _id: 'pin-head', prs: [liveLeaf(921)] });
    expect(nums(result.merged)).toContain(921);
    expect(merges).toHaveLength(1);
    const argv = merges[0];
    expect(argv[argv.indexOf('--match-head-commit') + 1]).toBe('sha-921');
  });

  it('xvzc4v4: the pin is the LISTING head, not the commits-read tip (a capped commits read cannot strand the PR)', () => {
    const { result, merges } = runDrainLiveRecordingMerges({ _id: 'pin-listed', prs: [liveLeaf(927, { headRefOid: 'sha-927-real-head', _headRefOid: 'sha-927-real-head' })] });
    expect(nums(result.merged)).toContain(927);
    const argv = merges[0];
    expect(argv[argv.indexOf('--match-head-commit') + 1]).toBe('sha-927-real-head');
  });

  it('xvzc4v4: a push after the pass-start read (live head ≠ judged head) is refused, never merged', () => {
    const { result, merges } = runDrainLiveRecordingMerges({ _id: 'head-moved', prs: [liveLeaf(922, { _headRefOid: 'sha-922-pushed-later' })] });
    expect(merges).toHaveLength(0);
    expect(nums(result.merged)).not.toContain(922);
    expect(result.revalidationAborted.find((x) => Number(x.num) === 922)?.reason).toMatch(/head moved/);
  });

  it('xvzc4v4: gh pr merge exits non-zero but the PR DID land — the pass completes and records it merged (no crash)', () => {
    const { result } = runDrainLiveRecordingMerges({ _id: 'lands-despite-error', prs: [liveLeaf(923, { _mergeFailButLands: true }), liveLeaf(924)] });
    expect(result).not.toBeNull(); // the pass produced its JSON result instead of dying on a ReferenceError
    expect(nums(result.merged)).toContain(923);
    expect(nums(result.merged)).toContain(924); // the rest of the pass still ran
    expect(nums(result.failed)).not.toContain(923);
  });

  it('xvzc4v4: a candidate merged out-of-band whose fresh re-read fails still gets its follow-up (recorded merged)', () => {
    const { result, merges, comments } = runDrainLiveRecordingMerges({ _id: 'merged-oob-read-fail', prs: [liveLeaf(925, { _freshReadFail: true, _state: 'MERGED' })] });
    expect(merges).toHaveLength(0);
    expect(nums(result.merged)).toContain(925);
    expect(nums(result.revalidationAborted || [])).not.toContain(925);
    // …and its merge-trace comment, like every other already-merged path (a no-op stub used to swallow it here).
    const traces = traceCommentsFor(comments, 925);
    expect(traces).toHaveLength(1);
    expect(traces[0].body).toMatch(/landed head `sha-925`/);
  });

  it('xvzc4v4: the confirmed-merge paths each post exactly one merge trace naming the pinned head', () => {
    const { comments } = runDrainLiveRecordingMerges({ _id: 'trace-paths', prs: [liveLeaf(928), liveLeaf(929, { _mergeFailButLands: true })] });
    expect(traceCommentsFor(comments, 928)).toHaveLength(1);
    expect(traceCommentsFor(comments, 928)[0].body).toMatch(/landed head `sha-928`/);
    expect(traceCommentsFor(comments, 929)).toHaveLength(1);
    expect(traceCommentsFor(comments, 929)[0].body).toMatch(/landed head `sha-929`/);
  });

  it('xvzc4v4: a failed fresh re-read on a still-OPEN PR fails closed (not merged, reported)', () => {
    const { result, merges } = runDrainLiveRecordingMerges({ _id: 'read-fail-open', prs: [liveLeaf(926, { _freshReadFail: true })] });
    expect(merges).toHaveLength(0);
    expect(nums(result.merged)).not.toContain(926);
    expect(nums(result.revalidationAborted)).toContain(926);
  });

  it('bare /merge sweep: the #2366 backstop refuses a PR already carrying review:pending, but lands a clean one', () => {
    const fixture = {
      _id: 'bare',
      prs: [
        { number: 201, title: 'parked by a prior drain', body: 'a real summary', headRefName: 'lane/d', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN,
          labels: [{ name: 'review:pending' }], _commits: AI_COMMIT, _files: [{ path: 'backlog/z.md', additions: 1, deletions: 0 }] },
        { number: 202, title: 'clean orphan', body: 'a real summary', headRefName: 'lane/e', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN,
          labels: [], _commits: AI_COMMIT, _files: [{ path: 'backlog/w.md', additions: 1, deletions: 0 }] },
      ],
    };
    const r = runDrain(fixture, []); // no --label ⇒ bare sweep ⇒ REVIEW_ESCALATION off ⇒ the #2366 backstop guards it

    // the review:pending PR must be refused (never re-shipped by a concurrent bare sweep) — plateau#11 / #290
    expect(nums(r.toMerge)).not.toContain(201);
    expect(nums(r.merged)).not.toContain(201);
    expect(nums(r.skipped)).toContain(201);

    // the clean orphan with no review label still lands — the backstop only refuses un-cleared labels
    expect(nums(r.toMerge)).toContain(202);
  });

  // #2820-review-fix REGRESSION GUARD — the root cause of the earlier break was "a new not-merge decision
  // (classifyPr's `reviewHeld` skip) SHORT-CIRCUITED an existing parking invariant": a review-held PR that used
  // to be PARKED (with humanRequired) got silently bucketed as bare `skipped`, losing that signal. The invariant
  // this guards: in a label-scoped drain, EVERY unsatisfied-review-hold PR that must-not-merge preserves its
  // routing through decideReviewGate — it appears in `r.parked` (never merges, never merely vanishes into
  // skipped-only), with humanRequired reflecting the hold's tier (review:human → true, review:changes → false).
  // The #103 case above covers the human tier; this covers the non-human tier through the SAME parking path.
  it('label-scoped drain: a review:changes leaf PARKS (wait-author, humanRequired:false) — the hold routing is preserved, not bare-skipped', () => {
    const fixture = {
      _id: 'changes-parks',
      prs: [
        { number: 301, title: 'clean leaf, no hold', body: 'a real summary', headRefName: 'lane/f', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN,
          labels: [{ name: 'ready-to-merge' }], _commits: AI_COMMIT, _files: [{ path: 'backlog/p.md', additions: 3, deletions: 0 }] },
        { number: 302, title: 'leaf the reviewer bounced', body: 'a real summary', headRefName: 'lane/g', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN,
          labels: [{ name: 'ready-to-merge' }, { name: 'review:changes' }], _commits: AI_COMMIT, _files: [{ path: 'backlog/q.md', additions: 2, deletions: 0 }] },
      ],
    };
    const r = runDrain(fixture, ['--label=ready-to-merge', '--no-reconcile-labels']);

    // the un-held leaf still lands — the fix is a no-op for a PR with no review label
    expect(nums(r.toMerge)).toContain(301);

    // the review:changes leaf must NOT merge, and must be PARKED (its routing preserved), not silently bare-skipped
    expect(nums(r.toMerge)).not.toContain(302);
    expect(nums(r.merged)).not.toContain(302);
    const p302 = r.parked.find((p) => Number(p.num) === 302);
    expect(p302).toBeTruthy();
    expect(p302.humanRequired).toBe(false); // review:changes is agent-reviewable (author lane fixes) — not human-only
  });

  // #2820-review-fix (finding 1) — the bare `--no-review-escalation` escape hatch. classifyPr's hold-skip was
  // threaded ONLY from the per-PR relief set, so a BARE flag ({passWide:true, prs:[]}) left allowPendingReview
  // false for every PR and the held review:pending PR was skipped BEFORE the !REVIEW_ESCALATION backstop (which
  // only downgrades merge→skip) could honour the waiver — the documented x30jq9n stuck-park exit was dead. The
  // pass-wide waiver is now threaded into classifyPr (gated on !!label, mirroring the backstop's allowPending).
  it('#2820-review-fix (finding 1): a bare --no-review-escalation LANDS a green review:pending PR (the escape hatch lives)', () => {
    const fixture = {
      _id: 'escape-hatch',
      prs: [
        { number: 401, title: 'green, parked pending, no reviewer coming', body: 'a real summary', headRefName: 'lane/h', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN,
          labels: [{ name: 'ready-to-merge' }, { name: 'review:pending' }], _commits: AI_COMMIT, _files: [{ path: 'backlog/r.md', additions: 2, deletions: 0 }] },
        { number: 402, title: 'reviewer-rejected — NEVER waived by the flag', body: 'a real summary', headRefName: 'lane/j', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN,
          labels: [{ name: 'ready-to-merge' }, { name: 'review:changes' }], _commits: AI_COMMIT, _files: [{ path: 'backlog/t.md', additions: 1, deletions: 0 }] },
      ],
    };
    const r = runDrain(fixture, ['--label=ready-to-merge', '--no-reconcile-labels', '--no-review-escalation']);

    // the operator override lands the stuck pending PR — the whole point of the escape hatch
    expect(nums(r.toMerge)).toContain(401);
    // but review:changes stays held even under the bare flag (the predicate never waives changes/human)
    expect(nums(r.toMerge)).not.toContain(402);
    expect(nums(r.merged)).not.toContain(402);
  });

  // #2820-review-fix (finding 2) — a green review:pending leaf whose fresh score DE-ESCALATES (a small backlog
  // leaf) must still PARK (agent-reviewable), never fall into decideReviewGate's old `!escalate`→merge dead zone
  // where classifyPr's hold-skip stranded it: skipped every pass AND absent from `parked`, so no reviewer is ever
  // dispatched. The sticky-pending branch keeps it in `parked` with a release path.
  it('#2820-review-fix (finding 2): a de-escalated review:pending leaf PARKS agent-reviewable, never the merge dead zone', () => {
    const fixture = {
      _id: 'pending-parks',
      prs: [
        { number: 501, title: 'green pending leaf, fresh score de-escalated', body: 'a real summary', headRefName: 'lane/i', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN,
          labels: [{ name: 'ready-to-merge' }, { name: 'review:pending' }], _commits: AI_COMMIT, _files: [{ path: 'backlog/s.md', additions: 1, deletions: 0 }] },
      ],
    };
    const r = runDrain(fixture, ['--label=ready-to-merge', '--no-reconcile-labels']);

    expect(nums(r.toMerge)).not.toContain(501);
    expect(nums(r.merged)).not.toContain(501);
    const p501 = r.parked.find((p) => Number(p.num) === 501);
    expect(p501).toBeTruthy();
    expect(p501.humanRequired).toBe(false);
  });

  // #2820-review-fix (finding 3) — a held PR that is ALSO unlandable for a more actionable reason (red CI) must
  // NOT be treated as `reviewHeld`: it keeps the CI reason and is a plain SKIP, never routed into the escalation
  // pass (and its mutating gates: #2414 baseline capture, the test-gaming review:human stamp). A green held PR
  // still parks (previous cases); this pins that the red one does not.
  it('#2820-review-fix (finding 3): a red-CI review:changes PR is a plain SKIP (CI reason), not parked into the mutating gates', () => {
    const RED = [{ name: 'test', conclusion: 'FAILURE', status: 'COMPLETED' }];
    const fixture = {
      _id: 'red-held',
      prs: [
        { number: 601, title: 'red CI + review:changes, mid-fix', body: 'a real summary', headRefName: 'lane/k', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: RED,
          labels: [{ name: 'ready-to-merge' }, { name: 'review:changes' }], _commits: AI_COMMIT, _files: [{ path: 'backlog/u.md', additions: 1, deletions: 0 }] },
      ],
    };
    const r = runDrain(fixture, ['--label=ready-to-merge', '--no-reconcile-labels']);

    expect(nums(r.toMerge)).not.toContain(601);
    expect(nums(r.merged)).not.toContain(601);
    expect(nums(r.skipped)).toContain(601);                       // plain skip for the CI reason…
    expect(r.parked.find((p) => Number(p.num) === 601)).toBeFalsy(); // …NOT routed through the escalation/parking path
  });

  // #2820-review-fix (round-3 finding 1) — the round-2 "de-dup" set `reviewParked = true` on ENTRY to the
  // park/wait-author branch, which suppressed the final #2313 skip-stamp for two kinds that post NOTHING of their
  // own: a `review:changes` wait-author (no `applyLabel`) and a de-escalated `review:human` park (empty reasons →
  // `buildEscalationReasonBlock([]) === ''`). The fix tracks whether a durable record was ACTUALLY posted. This is
  // the ONLY case that exercises the non-dry-run COMMENT paths, so it runs live (lease bypassed, merges nothing —
  // every fixture PR is held, `toMerge` is empty), recording every `gh pr comment`.
  // Scope: this covers the two kinds finding-1 restores (a NON-escalating review:changes wait-author, a
  // de-escalated review:human park) plus the agent review:pending park (which must NOT double). It does NOT
  // assert totality over ALL park kinds — an ESCALATING review:changes wait-author is separately/pre-existingly
  // suppressed by the untouched `escalated==='yes'` skip-loop exclusion (out of finding-1's scope; see the code).
  it('#2820-review-fix (finding 1): the two silenced park kinds regain their skip comment, and the agent park still posts exactly one (not doubled)', () => {
    const green = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN, body: 'a real summary', _commits: AI_COMMIT, _files: [{ path: 'backlog/u.md', additions: 1, deletions: 0 }] };
    const fixture = {
      _id: 'skip-stamp',
      prs: [
        { number: 701, title: 'review:changes wait-author', labels: [{ name: 'ready-to-merge' }, { name: 'review:changes' }], ...green },
        { number: 702, title: 'review:pending agent park',  labels: [{ name: 'ready-to-merge' }, { name: 'review:pending' }], ...green },
        { number: 703, title: 'review:human de-escalated leaf', labels: [{ name: 'ready-to-merge' }, { name: 'review:human' }], ...green },
      ],
    };
    const { result, comments } = runDrainLive(fixture, ['--label=ready-to-merge', '--no-reconcile-labels']);

    // Nothing merged — all three are held.
    expect(nums(result.toMerge)).toEqual([]);

    // Each of THESE three PRs gets EXACTLY ONE comment — the two restored kinds are no longer silenced, and the
    // agent park is not doubled. (Not a claim over all park kinds — see the scope note above.)
    for (const n of ['701', '702', '703']) {
      expect(comments.filter((c) => c.num === n).length).toBe(1);
    }
    // review:changes wait-author and the de-escalated review:human park post a SKIP stamp (their why, restored) —
    // before the fix they posted nothing at all.
    expect(comments.find((c) => c.num === '701').head).toContain('drain-skip-reason');
    expect(comments.find((c) => c.num === '703').head).toContain('drain-skip-reason');
    // The agent review:pending park still posts its own PARK comment — and only that one (the round-2 de-dup goal
    // — no byte-identical skip on top — is preserved by the corrected exclusion).
    expect(comments.find((c) => c.num === '702').head).toContain('drain-park-reason');
  });

  // #2820-review-fix (round-4 finding) — `durableRecorded` must be attested by the VERIFIED effect of the #2324
  // body write, NOT by merely HAVING COMPUTED the escalation block. A stale-acceptance review:human re-park writes
  // its "why" only into the PR body; when that `gh pr edit --body` write does not land, nothing was recorded. The
  // round-3 code set the flag from the computed block, so `reviewParked` went true and the final skip-stamp was
  // SUPPRESSED — the PR ended the pass with NO durable record at all (a regression vs main, which still fired the
  // skip fallback). Keying the flag off the existing `verified` re-fetch restores it: an unconfirmed write leaves
  // the flag false, so the skip loop stamps exactly one durable record. (The general class is swept by #2857.)
  it('#2820-review-fix (round 4): a stale-acceptance review:human re-park whose body write FAILS still ends the pass with exactly one durable record', () => {
    const fixture = {
      _id: 'attest-verified',
      prs: [
        {
          number: 801,
          title: 'stale-acceptance review:human re-park (body edit forced to fail)',
          labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }, { name: 'review:human' }],
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN,
          body: 'a real summary', _commits: AI_COMMIT,
          _files: [{ path: 'backlog/w.md', additions: 1, deletions: 0 }], // benign fresh diff → escalated:'no' → the skip loop is eligible to stamp
          _headRefOid: 'deadbeef',    // live head …
          _reviewedSha: 'cafef00d',   // … advanced past the reviewed SHA → review:accepted is STALE → re-park review:human
          _editBodyFail: true,        // force the #2324 body write to fail so `verified` stays false
        },
      ],
    };
    const { result, comments } = runDrainLive(fixture, ['--label=ready-to-merge', '--no-reconcile-labels']);

    // Held — never lands, and re-parked HUMAN (a stale acceptance re-parks to review:human).
    expect(nums(result.toMerge)).toEqual([]);
    expect(result.parked.find((p) => Number(p.num) === 801)?.humanRequired).toBe(true);
    // The regression guard: with the body write unconfirmed, the skip-stamp fallback fires — so the PR carries
    // EXACTLY ONE durable record of why it was not landed (before the fix it carried zero).
    expect(comments.filter((c) => c.num === '801').length).toBe(1);
    expect(comments.find((c) => c.num === '801').head).toContain('drain-skip-reason');
  });

  // #xmnl36p — THE WIRING, not the decider. `decideReviewGate` returning `revokesClearance` is worth nothing to
  // the operator unless the REAL entrypoint reads the clearance record, threads it into the gate, and posts the
  // notice. That delivery path had no coverage: reverting `scripts/merge-ai-prs.mjs` wholesale to main (deleting
  // the `parseOperatorClearance` read, the `operatorClearance` argument and the whole notice block) left every
  // suite GREEN — 540/540 — because the pure tests only exercise the library. This is the test that goes red for
  // that revert. It runs LIVE (lease bypassed) because the notice only exists on the non-dry-run comment path;
  // both fixtures are held, so `toMerge` is empty and nothing is merged.
  it('#xmnl36p: a stale re-park over an OPERATOR CLEARANCE posts the revocation notice — and posts none without one', () => {
    const stale = {
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN, body: 'a real summary',
      _commits: AI_COMMIT,
      // the declarative leash → the fresh score is humanRequired, exactly as WE PR #1106's was
      _files: [{ path: 'scripts/lib/gate-config.mjs', additions: 3, deletions: 1 }],
      _headRefOid: 'deadbeef',   // the drain's own rebase moved the head …
      _reviewedSha: 'cafef00d',  // … past the reviewed commit → review:accepted is STALE → re-park review:human
    };
    const fixture = {
      _id: 'clearance-revocation',
      prs: [
        // review:human is ABSENT — the operator's `--to=clear-human` removed it. Re-adding it REVOKES the clearance.
        { number: 901, title: 'cleared by the operator, then re-held by a rebase', _clearedBy: 'Nicolas Gilbert',
          labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }], ...stale },
        // byte-identical except that it was never `clear-human`-ed → no clearance to revoke → no notice
        { number: 902, title: 'never cleared by an operator',
          labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }], ...stale },
      ],
    };
    const { result, comments } = runDrainLive(fixture, ['--label=ready-to-merge', '--no-reconcile-labels']);

    // Both are held and re-parked HUMAN — the notice changes no merge decision (#2285 INVARIANT 2 intact).
    expect(nums(result.toMerge)).toEqual([]);
    expect(result.parked.find((p) => Number(p.num) === 901)?.humanRequired).toBe(true);
    expect(result.parked.find((p) => Number(p.num) === 902)?.humanRequired).toBe(true);

    // #901 — EXACTLY ONE revocation notice, naming who cleared it and the re-clear command.
    const notices901 = comments.filter((c) => c.num === '901' && c.body.includes('clearance was revoked by an automated re-score'));
    expect(notices901.length).toBe(1);
    expect(notices901[0].body).toContain('Nicolas Gilbert');
    expect(notices901[0].body).toContain('--to=clear-human');

    // #902 — no clearance record, so no notice. The notice fires on a REVOKED clearance, never on every re-park.
    expect(comments.filter((c) => c.num === '902' && c.body.includes('clearance was revoked'))).toEqual([]);
  });
});
