/**
 * @file breaks/stale-ready-candidate-missing-overlay.mjs — live incident, 2026-11-01 on `wev-review-daemon`:
 * `daemon-load-overlay` adopted a stale "superseded" ready-candidate (built before a newer overlay was registered)
 * and reported ADOPTED, silently dropping that overlay. Adoption only checked the overlay being loaded, never the
 * other registered overlays.
 *
 * THE FIX: `overlayInstalled` takes `refs` and requires EVERY registered overlay tip to be an ancestor of the
 * installed HEAD (`git merge-base --is-ancestor`); an unresolved tip, check error or unreadable registry refuses.
 *
 * SCENARIO: a real bare origin with `main`, `lane/a` and `lane/b`; a daemon clone whose HEAD holds main + lane/a
 * only (the stale candidate). Both overlays are registered. The rebuild stub "adopts" that HEAD. RED (pre-fix):
 * the load reports adopted:true although lane/b is missing. GREEN: it reports not adopted.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemonLoadOverlay, overlaySafetySettings, overlayInstalled } from '../../../lib/daemon-load-overlay.mjs';

const LOADER = 'scripts/lib/daemon-load-overlay.mjs';

export default {
  id: 'stale-ready-candidate-missing-overlay',
  title: 'a stale ready-candidate that lacks a registered overlay tip is refused at adoption, never reported adopted',
  card: 'handoff cards-to-file: daemon-load-overlay adopted a stale "superseded" ready-candidate',
  fixedBy: { sha: 'adopt-requires-all-overlays', where: 'lane/adopt-requires-all-overlays', paths: [LOADER] },
  fixPresent(root) {
    try { return readFileSync(join(root, LOADER), 'utf8').includes('readOverlayStateFn'); } catch { return false; }
  },
  async run({ log } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-stale-candidate-'));
    const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=soak', '-c', 'user.email=soak@example.invalid', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
    const violations = [];
    try {
      git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
      git(dir, 'clone', '-q', 'origin.git', 'up');
      const up = join(dir, 'up');
      git(up, 'checkout', '-q', '-b', 'main');
      writeFileSync(join(up, 'f.txt'), 'main\n'); git(up, 'add', '.'); git(up, 'commit', '-q', '-m', 'main'); git(up, 'push', '-q', 'origin', 'main');
      for (const n of ['a', 'b']) {
        git(up, 'checkout', '-q', '-b', `lane/${n}`, 'main');
        writeFileSync(join(up, `${n}.txt`), `${n}\n`); git(up, 'add', '.'); git(up, 'commit', '-q', '-m', n); git(up, 'push', '-q', 'origin', `lane/${n}`);
      }
      git(dir, 'clone', '-q', '-b', 'main', 'origin.git', 'daemon');
      const daemon = join(dir, 'daemon');
      git(daemon, 'fetch', '-q', 'origin');
      git(daemon, 'merge', '-q', '--no-edit', 'origin/lane/a'); // the stale candidate: has A, lacks B
      const realRun = (args, opts) => {
        try { return { status: 0, stdout: execFileSync('git', args, { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }) }; }
        catch (e) { return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; }
      };
      const quiet = { error() {}, log() {}, warn() {} };
      const result = await runDaemonLoadOverlay({
        clone: daemon, ref: 'lane/a', pr: 1, versions: null, log: quiet, followUpRebuilds: 0,
        settings: overlaySafetySettings({ WE_OVERLAY_DISPATCH_SMOKE: 'off' }, { readSettings: () => null }),
        addOverlayFn: () => {},
        readOverlayStateFn: () => ({ overlays: [{ ref: 'lane/a' }, { ref: 'lane/b' }], corrupt: false }),
        rebuild: async () => ({ moved: true, adopted: true, head: git(daemon, 'rev-parse', 'HEAD').trim(), reason: 'ready-adopted' }),
        installed: (o) => overlayInstalled({ ...o, run: realRun }),
      });
      log?.(JSON.stringify({ adopted: result.adopted, reason: result.reason }));
      if (result.adopted) {
        violations.push({ invariant: 'stale-candidate-adopted', detail: 'candidate missing registered overlay lane/b was reported adopted' });
      }
      return { violations, result: { adopted: result.adopted, reason: result.reason } };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
