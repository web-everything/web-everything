/** A pinned overlay branch that only fast-forwards past its audited pin keeps the ready proof; a force-push does not. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

// Executes the supplied checkout's real assertReadyCandidatePins against real git history. No source markers.
export function probe(checkout) {
  const dir = mkdtempSync(join(tmpdir(), 'ready-pin-moved-'));
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { strictEqual } from 'node:assert';
      import { writeFileSync, mkdirSync } from 'node:fs';
      import { join } from 'node:path';
      import { spawnSync } from 'node:child_process';
      import { pathToFileURL } from 'node:url';
      const [checkout, dir] = process.argv.slice(1);
      const url = f => pathToFileURL(join(checkout, 'scripts/lib', f)).href;
      const state = await import(url('daemon-rebuild/state.mjs'));
      const { REBUILD_IDENTITY_ENV } = await import(url('daemon-rebuild/shared.mjs'));
      const { overlayFilePath } = await import(url('daemon-overlays.mjs'));
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      const g = (...a) => { const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env,
        GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' } });
        if (r.status !== 0) throw new Error(a.join(' ') + r.stderr); return r.stdout.trim(); };
      g('init', '-q'); g('commit', '-q', '--allow-empty', '-m', 'base');
      const commit = m => { g('commit', '-q', '--allow-empty', '-m', m); return g('rev-parse', 'HEAD'); };
      const base = g('rev-parse', 'HEAD');
      const pinSha = commit('audited'), held = commit('held tip');
      const ref = 'lane/pin';
      const track = sha => g('update-ref', 'refs/remotes/origin/' + ref, sha);
      const env = { WE_DAEMON_STATE_DIR: dir, WE_DAEMON_OVERLAY_DIR: dir, WE_FIX_READY_PATH: join(dir, 'audited.jsonl'),
        WE_PLATFORM_PREFERENCES_FILE: join(dir, 'platform.json'), WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only' };
      writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{}');
      writeFileSync(env.WE_FIX_READY_PATH, JSON.stringify({ ref, sha: pinSha, tests: 'green', audit: 'NOT WEAKENED' }) + '\\n');
      writeFileSync(overlayFilePath(dir, env), JSON.stringify({ clone: dir, overlays: [{ ref, pr: 42 }] }));
      const head = 'c'.repeat(40), main = 'd'.repeat(40);
      const ready = { prevHead: head, tree: 't', passedAt: new Date(0).toISOString(), kind: 'candidate', forced: false,
        adopt: { finalSha: 'e'.repeat(40), inputsKey: 'k', mainSha: main, applied: [{ ref, pr: 42, sha: pinSha, pinnedFrom: held }] } };
      // Real git for the tip and ancestry; only the (unrelated) rebuild history is canned.
      const run = args => args[0] === 'log'
        ? { status: 0, stdout: main + ' ' + pinSha + '\\t' + REBUILD_IDENTITY_ENV.GIT_COMMITTER_EMAIL + '\\tdaemon-rebuild: merge overlay ' + ref + ' (PR #42) onto main\\n' }
        : args.includes('HEAD') ? { status: 0, stdout: head }
        : spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      const readFile = (await import('node:fs')).readFileSync;
      const verdict = () => { try { state.assertReadyCandidatePins(dir, ready, env, readFile, { run }); return 'accepts'; }
        catch (e) { return e instanceof state.StaleReadyPinError ? 'stale' : 'error:' + e.message; } };
      track(held); strictEqual(verdict(), 'accepts', 'unmoved tip');
      for (let i = 1; i <= 3; i++) { track(commit('push ' + i)); strictEqual(verdict(), 'accepts', 'fast-forward push ' + i); }
      g('checkout', '-q', '--detach', base);
      track(commit('force pushed away from the pin'));
      strictEqual(verdict(), 'stale', 'a force-push must stay stale');
    `, checkout, dir], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    return { violations: child.status === 0 ? [] : [
      `ready pin moved replay failed: ${child.error?.message ?? child.stderr ?? child.signal ?? child.status}`,
    ] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default {
  id: 'ready-pin-moved-keeps-adopting',
  title: 'a pinned overlay branch moving past its pin does not stale the ready candidate',
  card: 'READY-PIN-STALE-FIX',
  // Undo the follow-up's hunk edit before the original fix so replay also works after merges.
  fixedBy: { sha: 'ba386547a779cdb1d009da2e9543ad84b4999d73,25b340448853b86062436b97880a6a991387d0a1', where: 'lane/ready-pin-stale-fix', paths: ['scripts/lib/daemon-rebuild/state.mjs'] },
  fixPresent: checkout => probe(checkout).violations.length === 0,
  run: () => probe(root),
  judge: report => report.violations,
};
