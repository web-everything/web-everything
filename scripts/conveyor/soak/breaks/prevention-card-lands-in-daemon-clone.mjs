/**
 * @file breaks/prevention-card-lands-in-daemon-clone.mjs — live incident, 2026-09-28 (#4075 soak harness, card
 * we:backlog/4317). `fileApprovalPreventionCard` (`we:scripts/review-set-label.mjs`, run from
 * `runApprovalPreventionFiling` on every PR accept/clear-human) used to shell `node scripts/operations/run.mjs
 * file-item …` INLINE, with no cwd override — inheriting whatever checkout was reviewing the PR at the time.
 * That is routinely a READ-ONLY daemon clone (`wev-review-daemon`, `wev-control`, …), never committed to and
 * never pushed. Per `file-item`'s own header, landing is a separate `file-item`/`verify`/`open-pr` sequence
 * the filing hook never ran — so the freshly-filed `backlog/x*.md` card sat UNTRACKED forever: a daemon
 * rebuild's own dirty check reads `git status --untracked-files=no` by design (an untracked sidecar must never
 * block a rebuild), so nothing ever surfaced or landed it. Live 2026-09-28: 22 such orphans in
 * `wev-review-daemon`, 1 in `wev-control`, dating to PR #2807 — and the daemon clone going dirty this way is
 * exactly what a build daemon's self-sync refuses to rebuild over (the SAME invariant class
 * `session-junk-in-daemon-clone`/`scorecard-dirt` already cover for their own root causes).
 *
 * FIX (#4317, `we:scripts/review-set-label.mjs`): `fileApprovalPreventionCard` now spawns a DETACHED job
 * (`we:scripts/operations/land-prevention-card.mjs`, via the same `defaultSpawnDetached` primitive the
 * mechanical build dispatcher already uses) that acquires a REAL lane and runs the full
 * file-item/verify/open-pr sequence there, then releases the lane — so the calling checkout gets no new file
 * or directory anywhere under it, ever.
 *
 * Scenario: `fixtures/prevention-card-filer-probe.mjs` calls the REAL `fileApprovalPreventionCard` as a
 * SEPARATE process whose own cwd IS the daemon clone (`w.simCloneRoot`) — exactly how a real dispatched
 * session's Bash tool invokes `review-set-label.mjs`. A harmless `runScript` override
 * (`fixtures/prevention-card-noop-job.mjs`) stands in for the real landing job, so the fixed code's genuine
 * `defaultSpawnDetached` spawn still runs for real but stays inert, rather than actually acquiring a lane in
 * the background (that full arc is `land-prevention-card.test.mjs`'s own, separate, regression). The sim
 * world's own `we` template ships no `backlog/` directory at all (nothing else in this harness needs one), so
 * this scenario seeds and commits an empty one FIRST — otherwise `file-item`'s `read` step (a plain
 * `readdirSync`) refuses at `scandir ENOENT` before ever reaching a write, which would mask the very incident
 * this break exists to reproduce (verified while building this break: without a seeded `backlog/`, BOTH the
 * pre-fix and post-fix code read as innocently GREEN, for two entirely different, wrong reasons).
 *
 * RED (pre-fix) = the filer's call leaves a brand-new untracked `backlog/*.md` card in `w.simCloneRoot`, i.e.
 * the clone goes dirty. GREEN (post-fix) = the clone's `git status --porcelain` is byte-identical before and
 * after the call — the filer wrote nothing there itself.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runSoak } from '../soak.mjs';

const PROBE = fileURLToPath(new URL('./fixtures/prevention-card-filer-probe.mjs', import.meta.url));
const NOOP_JOB = fileURLToPath(new URL('./fixtures/prevention-card-noop-job.mjs', import.meta.url));

function porcelainStatus(root) {
  return execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
}

/** The sim `we` template carries no `backlog/` directory — seed and commit an empty one so `file-item`'s
 *  `read` step (a plain `readdirSync`) doesn't refuse at ENOENT before ever writing, which would mask this
 *  incident behind an unrelated refusal (see this file's own header). */
function seedEmptyBacklogDir(root) {
  const dir = join(root, 'backlog');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.gitkeep'), '');
  execFileSync('git', ['add', 'backlog/.gitkeep'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'soak: seed empty backlog/ for the prevention-card-filer break'], { cwd: root });
}

function runProbe(modulePath, input, cwd, env) {
  const res = spawnSync(process.execPath, [PROBE, modulePath, JSON.stringify(input), NOOP_JOB], {
    cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  let parsed = null;
  try { parsed = JSON.parse((res.stdout || '').trim() || 'null'); } catch { /* leave null — caller checks status/stderr */ }
  return { ...res, parsed };
}

export default {
  id: 'prevention-card-lands-in-daemon-clone',
  title: 'the approval-time prevention filer shelled file-item inline in whatever checkout reviewed the PR (routinely a daemon clone), leaving an untracked backlog card that dirtied it for good',
  card: 'we:backlog/4317 (epic #4075)',
  fixedBy: {
    sha: 'ee579b233',
    where: 'lane/4317-land-prevention-cards-via-lane',
    paths: ['scripts/review-set-label.mjs', 'scripts/lib/prevention-landing-job.mjs'],
  },
  // #4493 moved the detached-spawn machinery this marker originally tested for — `defaultSpawnDetached`,
  // referenced directly in `fileApprovalPreventionCard`'s own body — OUT of `review-set-label.mjs` and into a
  // shared leaf (`scripts/lib/prevention-landing-job.mjs#spawnPreventionLandingJob`, reused by a SECOND caller,
  // `review-loop-cli.mjs`). `fileApprovalPreventionCard` is now a thin wrapper that delegates to it and no
  // longer mentions `defaultSpawnDetached` by name — so the ORIGINAL single-string check went stale on a
  // behavior-preserving refactor it never anticipated (live-caught, 2026-09-29, PR #2983 CI). Check either the
  // pre-#4493 shape (the reference still inline, for a tree that predates the extraction) or the post-#4493
  // shape (the wrapper delegates to the shared leaf, which itself carries the reference) — both are "the fix is
  // present", by the SAME test #4317 always meant: nothing in the calling checkout drives `file-item` directly.
  fixPresent(root) {
    try {
      const wrapper = readFileSync(join(root, 'scripts/review-set-label.mjs'), 'utf8');
      if (/defaultSpawnDetached/.test(wrapper)) return true;
      if (!/spawnPreventionLandingJob/.test(wrapper)) return false;
      const leaf = readFileSync(join(root, 'scripts/lib/prevention-landing-job.mjs'), 'utf8');
      return /defaultSpawnDetached/.test(leaf);
    } catch { return false; }
  },
  async run({ log } = {}) {
    return runSoak({
      name: 'break:prevention-card-lands-in-daemon-clone',
      rounds: 1,
      mainEvery: 0,
      fleet: false,
      daemons: [],
      log,
      setup(w) {
        seedEmptyBacklogDir(w.simCloneRoot);
        return {};
      },
      async perRound(w, round, ctx, api) {
        if (round !== 0) return;

        const before = porcelainStatus(w.simCloneRoot);
        api.say(`r00 daemon clone status before the filer runs: ${before.trim() || '(clean)'}`);

        const modulePath = join(w.simCloneRoot, 'scripts', 'review-set-label.mjs');
        const input = {
          title: 'Soak-break reproduction: prevention card filing probe',
          kind: 'story', // sized, so not a `task` (a sized task is refused — #x0h3pe4)
          size: '1',
          digest: 'Soak-harness reproduction of the #4317 daemon-clone-dirt incident — safe to delete.',
          scope: 'we:scripts/conveyor/soak/breaks/prevention-card-lands-in-daemon-clone.mjs',
          parent: '4075',
          queue: 'false',
        };
        const res = runProbe(modulePath, input, w.simCloneRoot, { ...process.env, ...w.env });
        api.say(`r00 fileApprovalPreventionCard exited ${res.status} → ${JSON.stringify(res.parsed)}${res.stderr ? ` stderr=${res.stderr.trim().split('\n')[0]}` : ''}`);

        const after = porcelainStatus(w.simCloneRoot);
        api.say(`r00 daemon clone status after the filer ran: ${after.trim() || '(clean)'}`);

        if (after !== before) {
          const newLines = after.split('\n').filter((l) => l && !before.includes(l));
          api.violation('clean', `fileApprovalPreventionCard dirtied the reviewing checkout: ${newLines.join('; ') || after.trim()}`);
        }
      },
    });
  },
  judge(report) {
    return report.violations
      .filter((v) => v.invariant === 'clean')
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
