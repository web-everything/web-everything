/**
 * @file breaks/already-done-burst-unattributed.mjs — #4415 round 2. LIVE incident, 2026-09-29 ~11:45Z: the
 * app installation's shared GraphQL bucket was drained again AFTER round 1's fix landed — `gh-spend.mjs
 * report --hours=1 --by=caller` showed 8943 points spent that hour, of which 6365.2 were UNATTRIBUTED (even
 * MORE than round 1's 1020.9). A `ps aux` snapshot caught the cause directly: 80-100+ `gh pr list --search
 * "<hash> in:title" --state merged --limit 5 …` processes running SIMULTANEOUSLY, one per stale backlog item.
 *
 * ROOT CAUSE: `scripts/readiness/dispatch-plan.mjs`'s already-done pass —
 * `Promise.all(staleQueueRows.map((row) => defaultCheckAlreadyDoneAsync(row.num)))`, NO concurrency cap of its
 * own — where `defaultCheckAlreadyDoneAsync` (`scripts/operations/dispatch-lane-io.mjs`) defaulted its
 * `execFileFn` to the bare promisified `node:child_process` `execFile`: never `execFileSyncThrottled`, so (a)
 * invisible to `gh-throttle.mjs`'s attribution log, and (b) UNBOUNDED concurrency — nothing capped how many
 * `gh` subprocesses could run at once. Its sync sibling `defaultCheckAlreadyDone`, `defaultListPrs`,
 * `createDispatchObservers`'s `exec`, `readTick`'s `exec`, and `defaultLaneRefForPr` carried the identical
 * defect (fixed in the same change; this break exercises the async, burst-causing one specifically, since
 * that is the shape the live `ps aux` snapshot actually caught).
 *
 * Fix: the default is now `execFileThrottledAsync` — an async-signature wrapper around
 * `execFileSyncThrottled` (the SAME shared attribution log + concurrency semaphore every other `gh` caller in
 * this codebase goes through, `gh-throttle.mjs`). Deliberately RE-SERIALIZES what was unbounded/parallel: the
 * sync call underneath blocks the event loop for its own duration, so `Promise.all`-mapped callers now queue
 * through it rather than all hitting `gh` at once — trading latency for a bounded, attributed rate, which is
 * exactly the direction this incident needed.
 *
 * Scenario: a PATH-faked `gh` that logs every invocation's argv to a file and answers every `pr list --search`
 * call with an empty JSON array (success) — the invariant under test is never "does `gh` fail", it is
 * "is a burst of many concurrent already-done checks attributed at all". `defaultCheckAlreadyDoneAsync` is
 * called `COUNT` times via `Promise.all`, exactly as `dispatch-plan.mjs` itself does, with NO `execFileFn`
 * override — the real production default — inside a fresh child process.
 */
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghThrottleLockRoot, ghThrottleLogPath } from '../../../lib/gh-throttle.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const FIXTURE = fileURLToPath(new URL('./fixtures/already-done-burst-unattributed.mjs', import.meta.url));
const COUNT = 20;

export default {
  id: 'already-done-burst-unattributed',
  title: 'dispatch-plan\'s already-done pass ran an UNBOUNDED Promise.all burst of PR-list searches, defaulted to a bare promisified execFile — invisible to gh-spend.mjs, the top drain of the shared graphql bucket a second time',
  card: 'we:backlog/4415',
  fixedBy: { sha: 'bc0c364a2', where: 'lane/graphql-unattributed-spender-2', paths: ['scripts/operations/dispatch-lane-io.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/operations/dispatch-lane-io.mjs');
    return existsSync(p) && /execFileThrottledAsync/.test(readFileSync(p, 'utf8'));
  },
  async run({ log } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-already-done-burst-'));
    const bin = mkdtempSync(join(tmpdir(), 'soak-already-done-burst-gh-'));
    const lockRoot = join(dir, 'throttle');
    const argvLog = join(dir, 'argv.log');
    writeFileSync(join(bin, 'gh'), [
      '#!/bin/sh',
      // One line per invocation: the graphql query argument itself spans several lines.
      `{ printf '%s' "$*" | tr '\\n' ' '; printf '\\n'; } >> '${argvLog}'`,
      "echo '[]'",
      '',
    ].join('\n'));
    chmodSync(join(bin, 'gh'), 0o755);
    // The fixture's cwd is a throwaway SHALLOW repo with a github `origin`, never the host checkout: the local
    // merged-PR index (`readGitAlreadyDone`) only steps aside for the `gh` path under a shallow clone, so running
    // in the real checkout made this break depend on CI's clone depth (a full clone fetched origin/main — a live
    // remote read — and never reached the `gh` burst under test).
    const repo = mkdtempSync(join(tmpdir(), 'soak-already-done-burst-repo-'));
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv }).trim();
    git('init', '-q');
    git('remote', 'add', 'origin', 'https://github.com/web-everything/web-everything.git');
    git('-c', 'user.name=soak', '-c', 'user.email=soak@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'seed');
    writeFileSync(join(repo, '.git', 'shallow'), `${git('rev-parse', 'HEAD')}\n`);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, WE_GH_THROTTLE_LOCK_ROOT: lockRoot };
    const violations = [];
    let report;
    try {
      const out = execFileSync(process.execPath, [FIXTURE, REPO_ROOT, String(COUNT)], {
        cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 60_000, killSignal: 'SIGKILL',
      });
      log?.(out.trim());
      report = JSON.parse(out.trim().split('\n').pop());
    } catch (e) {
      violations.push({ invariant: 'crash', detail: String(e?.stderr || e?.message || e).split('\n')[0] });
      return { violations };
    }
    if (!report.ok) {
      violations.push({ invariant: 'burst-threw', detail: `Promise.all of ${COUNT} defaultCheckAlreadyDoneAsync calls rejected: ${report.error}` });
      return { violations, report };
    }
    if (report.count !== COUNT || !report.everyChecked) {
      violations.push({ invariant: 'not-all-checked', detail: `expected all ${COUNT} calls to resolve checked:true, got ${JSON.stringify(report)}` });
    }
    const argvLines = existsSync(argvLog) ? readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    if (argvLines.length !== COUNT) {
      violations.push({ invariant: 'gh-not-invoked-as-expected', detail: `expected exactly ${COUNT} real gh invocations (one per id), got ${argvLines.length}` });
    }
    const callLogPath = ghThrottleLogPath(ghThrottleLockRoot(undefined, env));
    const callLines = existsSync(callLogPath) ? readFileSync(callLogPath, 'utf8').trim().split('\n').filter(Boolean) : [];
    if (callLines.length === 0) {
      violations.push({ invariant: 'unattributed-spend', detail: `no line at all in gh-throttle's own call log (${callLogPath}) for a burst of ${COUNT} already-done checks — this spend is invisible to gh-spend.mjs report, exactly the 2026-09-29 ~11:45Z incident shape (${argvLines.length} real gh invocations happened, 0 were logged)` });
    }
    return { violations, report: { ...report, argvInvocations: argvLines.length, throttleLogLines: callLines.length } };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
