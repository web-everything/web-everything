import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { addOverlay } from '../../daemon-overlays.mjs';
import { writeReadyCandidate, writeRebuildState } from '../../daemon-rebuild/state.mjs';

export function fixture() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'safe-point-'));
  const root = join(dir, 'clone');
  mkdirSync(root);
  const run = (args, opts = {}) => spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: opts.cwd ?? root, env: opts.env ?? process.env, encoding: 'utf8', timeout: 10000,
  });
  const git = (...args) => {
    const result = run(args);
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'base.txt'), 'base');
  git('add', '.'); git('commit', '-qm', 'base');
  const head = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', head);
  const applied = [];
  for (const ref of ['A', 'B']) {
    writeFileSync(join(root, `${ref}.txt`), ref);
    git('add', '.'); git('commit', '-qm', `overlay ${ref}`);
    const sha = git('rev-parse', 'HEAD');
    git('update-ref', `refs/remotes/origin/${ref}`, sha);
    applied.push({ ref, sha });
    git('reset', '--hard', head);
  }
  for (const a of applied) git('merge', '--no-ff', '-qm', `daemon-rebuild: merge overlay ${a.ref}`, a.sha);
  const target = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/candidate', target);
  git('reset', '--hard', head);
  const env = { ...process.env, WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(dir, 'locks'), WE_DAEMON_AUTO_REBASE: '0', WE_DAEMON_REBUILD_AS_JOB: '0' };
  for (const a of applied) addOverlay(root, { ref: a.ref }, { env });
  writeRebuildState(root, {}, env);
  const plan = { finalSha: target, mainSha: head, applied, inputsKey: 'candidate-inputs', decisions: [] };
  const ready = { kind: 'candidate', prevHead: head, adopt: plan, tree: git('rev-parse', `${target}^{tree}`), passedAt: new Date().toISOString() };
  const record = () => writeReadyCandidate(root, ready, env);
  return { dir, root, run, git, env, head, target, plan, ready, record, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
