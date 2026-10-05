/**
 * @file breaks/fixer-wait-loop-undetected.mjs — live break, 2026-10-04 (PR #3771, card xegykal). A fixer held its PR
 * fix claim for 1h27 with no push while looping on `verify-lane check --wait=540000` — 11 nine-minute waits — and
 * nothing noticed.
 *
 * LIVE INCIDENT: `fix-3771` (web-everything/web-everything PR #3771), found by a manual transcript read at 09:20 ET.
 * Its transcript was never idle, so `hung-session.mjs`'s 30-minute idle test (3x grace while a call is pending)
 * read it as fresh; no health smell measured fix-claim age; nothing read what the session was actually doing.
 *
 * FIX — `scripts/conveyor/session-watchdog.mjs` + the health watch's `probeSessionWatchdog` + the `fixer-stuck` /
 * `fix-claim-held-no-progress` smells: past its kind's standard duration, a session's transcript tail is read and
 * classified; a waiting-loop while holding a fix claim opens `fixer-stuck`, and a claim held past standard with the
 * PR head unchanged opens `fix-claim-held-no-progress`.
 *
 * SCENARIO: the recorded transcript (`fixtures/fix-3771-wait-loop.jsonl`) and the live claim, replayed at 13:20Z
 * through every detector the tree under test has. RED = no detector flags fix-3771. GREEN = an episode opens on
 * PR #3771.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const RUNNER = fileURLToPath(new URL('./fixtures/fixer-wait-loop-undetected.mjs', import.meta.url));

export default {
  id: 'fixer-wait-loop-undetected',
  title: 'a fixer looping on verify-lane waits held its PR fix claim 1h27 with no push, and no detector read its transcript',
  card: 'we:backlog/5105 (epic #3383)',
  fixedBy: {
    sha: '1cf1409bc', where: 'lane/session-watchdog',
    paths: [
      'scripts/conveyor/session-watchdog.mjs', 'scripts/conveyor/health-watch.mjs',
      'scripts/conveyor/health-smells/fixer-stuck.mjs', 'scripts/conveyor/health-smells/fix-claim-held-no-progress.mjs',
    ],
  },
  fixPresent(root) {
    return existsSync(join(root, 'scripts/conveyor/session-watchdog.mjs'))
      && existsSync(join(root, 'scripts/conveyor/health-smells/fixer-stuck.mjs'));
  },
  run({ log } = {}) {
    const tmp = mkdtempSync(join(tmpdir(), 'soak-wait-loop-'));
    const env = { ...process.env, CLAUDE_PROJECTS_DIR: join(tmp, 'projects'), OPERATION_COMPLETIONS_DIR: join(tmp, 'completions') };
    mkdirSync(env.CLAUDE_PROJECTS_DIR, { recursive: true });
    try {
      const out = execFileSync(process.execPath, [RUNNER, REPO_ROOT, tmp], { encoding: 'utf8', env, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
      const report = JSON.parse(out.trim().split('\n').pop());
      log?.(JSON.stringify(report));
      const violations = report.detected ? [] : [{
        invariant: 'stuck-fixer-undetected',
        detail: `fix-3771 at 13:20Z (87 min into an 11-wait verify loop, claim held, no push): hung-session reads hung=${report.hung.hung} (${report.hung.reason}) and no health episode names PR #3771`,
      }];
      return { violations, report };
    } catch (e) {
      return { violations: [{ invariant: 'crash', detail: String(e?.stderr || e?.message || e).split('\n').slice(0, 3).join(' ') }] };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
