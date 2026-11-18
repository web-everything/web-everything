/** PR #6051 corruption alerts and PR #6219 conflict recovery with main's merge attributes. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addOverlay, overlayFilePath } from '../../../lib/daemon-overlays.mjs';
import { kickOverlayMainSync, runOverlayMainSync } from '../../../lib/daemon-rebuild/overlay-main-sync.mjs';
import { alertsFilePath } from '../../../lib/daemon-rebuild/state.mjs';

const SOURCE = 'scripts/lib/daemon-rebuild/overlay-main-sync.mjs';

/** A daemon still on the base must use the same main attributes as its scratch worker. */
export async function movedTipAttributeViolations(sync = { kickOverlayMainSync, runOverlayMainSync }) {
  const dir = mkdtempSync(join(tmpdir(), 'soak-main-sync-attributes-'));
  const root = join(dir, 'daemon'), origin = join(dir, 'origin.git'), ref = 'lane/attributes';
  const env = { ...process.env, TMPDIR: dir, WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'),
    WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_EVENTS: join(dir, 'events.jsonl'),
    WE_NEEDS_YOU_FEED: join(dir, 'needs-you.jsonl'), WE_PLATFORM_PREFERENCES_FILE: join(dir, 'missing') };
  const git = (args, opts = {}) => spawnSync('git', ['-c', 'user.name=soak', '-c', 'user.email=soak@example.invalid', ...args],
    { cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024, ...opts });
  const ok = args => {
    const r = git(args);
    if (r.status !== 0) throw new Error(`attribute scenario Git failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (file, text) => writeFileSync(join(root, file), text);
  try {
    mkdirSync(root); mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'docs/agent'), { recursive: true });
    ok(['init', '-q', '-b', 'main']);
    write('.gitignore', 'node_modules/\n'); write('worker.mjs', 'export default 0;\n');
    write('docs/agent/testing.md', '# Testing\n');
    ok(['add', '.']); ok(['commit', '-qm', 'base']);
    const base = ok(['rev-parse', 'HEAD']);
    ok(['checkout', '-qb', ref]);
    write('worker.mjs', 'export default 1;\n');
    write('docs/agent/testing.md', '# Testing\nOverlay notes\n');
    ok(['commit', '-qam', 'overlay']);
    const oldTip = ok(['rev-parse', 'HEAD']);
    ok(['checkout', '-q', 'main']);
    write('worker.mjs', 'export default 2;\n');
    write('docs/agent/testing.md', '# Testing\nMain notes\n');
    write('.gitattributes', 'docs/agent/testing.md merge=union\n');
    ok(['add', '.']); ok(['commit', '-qm', 'main attributes']);
    const main = ok(['rev-parse', 'HEAD']);
    ok(['clone', '-q', '--bare', root, origin]);
    ok(['remote', 'add', 'origin', origin]);
    ok(['update-ref', 'refs/remotes/origin/main', main]);
    ok(['update-ref', `refs/remotes/origin/${ref}`, oldTip]);
    ok(['checkout', '-q', '--detach', base]);
    addOverlay(root, { ref, pr: 123 }, { env });
    let conflict;
    try { await sync.runOverlayMainSync({ root, ref, env, deps: { git } }); }
    catch (error) { conflict = error; }
    const violations = [];
    if (!conflict?.message.includes('worker.mjs')) violations.push('worker did not record the genuine source conflict');
    ok(['checkout', '-q', ref]); write('worker.mjs', 'export default 2;\n');
    ok(['commit', '-qam', 'resolve source conflict']);
    const tip = ok(['rev-parse', 'HEAD']);
    ok(['--git-dir=' + origin, 'fetch', '-q', root, `${tip}:refs/heads/${ref}`]);
    ok(['checkout', '-q', '--detach', base]);
    let spawns = 0;
    const result = sync.kickOverlayMainSync({ root, ref, env, mode: 'on', git,
      spawnFn: () => { spawns++; return { once() {}, unref() {} }; } });
    if (spawns !== 1 || !result.started.includes(ref)) violations.push('main union attributes did not lift the resolved conflict stop');
    const state = JSON.parse(readFileSync(`${overlayFilePath(root, env)}.main-sync.state`, 'utf8'));
    if (state.conflictMain[ref] || state.attemptedMain[ref]) violations.push('resolved conflict memory retained');
    return violations;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export default {
  id: 'overlay-main-sync-corrupt-alerts',
  title: 'corrupt main-sync state alerts once and resolved conflicts recover with main attributes',
  card: 'PR #6051 / PR #6219',
  fixedBy: { sha: 'HEAD', where: 'lane/overlay-main-sync', paths: [SOURCE] },
  fixPresent(root) { return readFileSync(join(root, SOURCE), 'utf8').includes('function rateLimitedAlert('); },
  async run() {
    const root = mkdtempSync(join(tmpdir(), 'soak-main-sync-alerts-'));
    const env = { WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'), WE_DAEMON_STATE_DIR: join(root, 'state') };
    const violations = [];
    let gitCalls = 0, spawns = 0;
    try {
      for (const ref of ['lane/one', 'lane/two']) addOverlay(root, { ref }, { env });
      const file = `${overlayFilePath(root, env)}.main-sync.state`;
      writeFileSync(file, '{corrupt');
      for (let tick = 0; tick < 6; tick++) kickOverlayMainSync({ root, env, mode: 'on',
        git: () => { gitCalls++; throw new Error('unexpected Git call'); },
        spawnFn: () => { spawns++; throw new Error('unexpected spawn'); },
      });
      const rows = readFileSync(alertsFilePath(root, env), 'utf8').trim().split('\n').map(JSON.parse);
      for (const ref of ['lane/one', 'lane/two']) {
        const count = rows.filter(row => row.detail.ref === ref).length;
        if (count !== 1) violations.push(`${ref}: expected one alert after six ticks, got ${count}`);
      }
      if (gitCalls || spawns) violations.push('corrupt state authorized Git or a worker');
      if (readFileSync(file, 'utf8') !== '{corrupt') violations.push('corrupt evidence overwritten');
      violations.push(...await movedTipAttributeViolations());
      return { violations };
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
