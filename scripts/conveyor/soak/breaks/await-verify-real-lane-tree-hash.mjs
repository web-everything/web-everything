/**
 * @file breaks/await-verify-real-lane-tree-hash.mjs — review finding on PR 4151 (card we:backlog/5137, slices 2+3).
 * The harness's verdict pass only pushes a green whose verified tree hash equals the lane's tree hash NOW. Every
 * unit test, the soak replay and the fix-4115 replay injected a hand-matched `treeHash`, so none saw that the
 * production `laneState` (a) hashed UNTRIMMED `git diff` output while `verify-lane.mjs` records its marker through a
 * `git(...).trim()` helper — a real diff ends in "\n", so the hashes never matched — and (b) ran git with
 * `-c diff.external=`, which makes every `git diff` die ("cannot run ''"), so the hash was always null.
 * Either way every GREEN became `tree-unproven` → re-request ×2 → blocked-on-infra: the harness never pushed.
 *
 * FIX — `laneState` hashes through the same trimming runner shape as verify-lane (with `--no-ext-diff`, no
 * `diff.external=` pin).
 *
 * SCENARIO: a REAL git lane (origin/main + one local commit + an untracked-then-committed file), a green marker whose
 * treeHash is computed the way `verify-lane.mjs` computes it, and the tree's own production `laneState` feeding the
 * tree's own pass. RED = the pass answers anything but a push of the verified sha.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const PASS = 'scripts/conveyor/await-verify-pass.mjs';
const GATE = 'scripts/lib/verify-lane-gate.mjs';

export async function replay(root = REPO_ROOT) {
  if (!existsSync(join(root, PASS))) return { harness: false };
  const { runAwaitVerifyPass, defaultAwaitVerifyIo } = await import(pathToFileURL(join(root, PASS)).href);
  const { computeWorkingTreeHash } = await import(pathToFileURL(join(root, GATE)).href);
  const tmp = mkdtempSync(join(tmpdir(), 'soak-await-hash-'));
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
    const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, maxBuffer: 64 * 1024 * 1024 });
    const id = ['-c', 'user.name=s', '-c', 'user.email=s@s', '-c', 'commit.gpgsign=false'];
    const origin = join(tmp, 'origin.git'); const lane = join(tmp, 'lane');
    git(tmp, ['init', '--bare', '-b', 'main', origin]);
    git(tmp, ['clone', origin, lane]);
    writeFileSync(join(lane, 'a.txt'), 'one\n');
    git(lane, ['add', 'a.txt']); git(lane, [...id, 'commit', '-m', 'one']); git(lane, ['push', 'origin', 'HEAD:main']);
    writeFileSync(join(lane, 'a.txt'), 'one\ntwo\n'); writeFileSync(join(lane, 'b.txt'), 'new\n');
    git(lane, ['add', '-A']); git(lane, [...id, 'commit', '-m', 'fix']);
    const sha = git(lane, ['rev-parse', 'HEAD']).trim();
    // exactly how scripts/verify-lane.mjs records `marker.treeHash`
    const treeHash = computeWorkingTreeHash({ runGit: (a) => git(lane, a).trim(), fileMode: (f) => lstatSync(join(lane, f)).mode });

    const real = await defaultAwaitVerifyIo({ weRoot: root, env });
    const store = new Map([['s', { v: 1, sessionId: 's', who: 'fix-1', repo: CONSTELLATION_REPOS.we.slug, pr: 1, sha, requestedAt: new Date(0).toISOString(),
      attempt: 1, lane, ref: 'lane/item-1', kind: 'fix' }]]);
    const pushes = []; let rerequests = 0;
    const io = {
      listRecords: () => [...store.entries()].map(([key, record]) => ({ key, record })),
      writeRecord: (r) => { store.set(r.sessionId, r); return { ok: true }; },
      clearRecord: (key) => { store.delete(key); },
      laneState: (l) => real.laneState(l), // the production implementation under test
      readMarker: () => ({ sha, status: 'green', startedAt: new Date(0).toISOString(), treeHash, exitCode: 0 }),
      rerequest: () => { rerequests += 1; return { ok: true }; },
      push: (a) => { pushes.push(a.sha); return { ok: true }; },
      listSessions: () => [{ sessionId: 's', name: 'fix-1', cwd: '/scratch', state: 'done' }],
      resume: () => ({ resumed: true }),
    };
    const state = real.laneState(lane);
    await runAwaitVerifyPass({ io, nowMs: 60_000, ttlMs: 150 * 60_000 });
    return { harness: true, laneTreeHash: state?.treeHash ?? null, verifiedTreeHash: treeHash, pushes, rerequests, sha };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export default {
  id: 'await-verify-real-lane-tree-hash',
  title: 'the harness verdict pass never pushed a real green: its lane tree hash (untrimmed / diff.external= pin) never equalled the gate\'s',
  card: 'we:backlog/5137 (slices 2+3) — PR 4151 review',
  fixedBy: { sha: '3cfea6083,50cdb665b', where: 'lane/5137-s2-s3', paths: [PASS] },
  fixPresent(root) { return existsSync(join(root, PASS)); },
  async run({ log } = {}) {
    try {
      const report = await replay();
      log?.(JSON.stringify(report));
      const violations = [];
      if (!report.harness) violations.push({ invariant: 'model-owns-wait', detail: 'no harness verdict pass' });
      else {
        if (report.laneTreeHash !== report.verifiedTreeHash) violations.push({ invariant: 'tree-hash-mismatch', detail: `lane ${String(report.laneTreeHash).slice(0, 12)} vs the gate's ${String(report.verifiedTreeHash).slice(0, 12)}` });
        if (JSON.stringify(report.pushes) !== JSON.stringify([report.sha])) violations.push({ invariant: 'green-never-pushed', detail: `pushes ${JSON.stringify(report.pushes)}, re-requests ${report.rerequests}` });
      }
      return { violations, report };
    } catch (e) {
      return { violations: [{ invariant: 'crash', detail: String(e?.stack || e).split('\n').slice(0, 3).join(' ') }] };
    }
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
