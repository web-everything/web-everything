/** Replay fallback adoption with real Git and smoke orchestration; external children are injected. */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { rebuildClone, readRebuildState } from '../../../lib/daemon-rebuild.mjs';
import { addOverlay, readOverlays } from '../../../lib/daemon-overlays.mjs';
import { runLiveSmoke } from '../../../lib/daemon-live-smoke.mjs';

export async function probeFallbackFreshSmoke({ readyOnly = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'rebuild-fallback-fresh-'));
  const root = join(base, 'clone'), origin = join(base, 'origin.git');
  const env = { PATH: process.env.PATH, WE_DAEMON_STATE_DIR: join(base, 'state'),
    WE_DAEMON_SMOKE_STATE_DIR: join(base, 'smoke-slots'),
    WE_DAEMON_OVERLAY_DIR: join(base, 'overlays'), WE_DAEMON_CLONE_LOCK_ROOT: join(base, 'locks'),
    WE_DAEMON_EVENTS: join(base, 'events.jsonl'), WE_NEEDS_YOU_FEED: join(base, 'needs-you.jsonl'),
    WE_PLATFORM_PREFERENCES_FILE: join(base, 'missing'), WE_DAEMON_REBUILD_SKIP_UNRELATED: '0',
    WE_DAEMON_OVERLAY_FOLLOW_TIP: 'follow',
    WE_SMOKE_LOAD_SCALE: '0', WE_SMOKE_BUSY_LOAD_RATIO: '1e9', WE_SMOKE_DISPATCH_PASSES: '0' };
  // Exercise the standard ten-minute window, independent of the invoking shell.
  delete env.WE_SMOKE_GH_ROW_REUSE_MAX_AGE_MS;
  const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 }).trim();
  const checks = [];
  const errors = [];
  try {
    git(base, ['init', '--bare', '-q', origin]);
    mkdirSync(root);
    git(root, ['init', '-q', '-b', 'main']);
    writeFileSync(join(root, 'README.md'), 'base\n');
    git(root, ['add', '.']); git(root, ['commit', '-qm', 'base']);
    const previous = git(root, ['rev-parse', 'HEAD']);
    git(root, ['remote', 'add', 'origin', origin]);
    writeFileSync(join(root, 'main.txt'), 'new main\n');
    git(root, ['add', '.']); git(root, ['commit', '-qm', 'main']);
    git(root, ['push', '-qu', 'origin', 'main']);
    const main = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '-qb', 'lane/bad']);
    writeFileSync(join(root, 'bad.txt'), 'broken overlay\n');
    git(root, ['add', '.']); git(root, ['commit', '-qm', 'bad']);
    git(root, ['push', '-qu', 'origin', 'lane/bad']);
    git(root, ['checkout', '-q', '-B', 'main', previous]);
    addOverlay(root, { ref: 'lane/bad' }, { env });
    const runSmoke = async options => {
      const bad = existsSync(join(options.root, 'bad.txt'));
      let ghCalls = 0;
      const smoke = await runLiveSmoke({ ...options, shadow: () => null, admit: () => null,
        runChild: async (cmd, args, opts) => {
          if (cmd === 'gh') ghCalls++;
          if (bad && opts.env.GH_CALLER === 'rebuild-smoke:dispatch-dry-run') return 'malformed JSON';
          if (args[1] === 'list') return '[]';
          if (args[1] === 'acquire') return '{"lane":1}';
          if (cmd === 'node' && args[0] === '--input-type=module') {
            return String(args[2]).includes('daemon-boot-smoke:entry-boot')
              ? '{"ok":true}' : '[{"kind":"stub","pr":null,"ok":true}]';
          }
          return cmd === 'node' ? '{"ok":true}' : '';
        },
      });
      checks.push({ bad, ghCalls, pass: smoke.pass, reuseRows: options.reuseRows.map(row => row.name),
        reused: smoke.results.filter(row => row.reused).map(row => row.name),
        failed: smoke.results.filter(row => !row.ok).map(row => ({ name: row.name, detail: row.detail })) });
      return { verdict: smoke.pass ? 'pass' : 'code', smoke };
    };
    const options = { root, env, runSmoke, prState: async () => null,
      log: { error(message) { if (message.includes('smoke-threw')) errors.push(message); } },
      dispatchSmoke: { settings: { dispatchSmoke: 'off' }, run: async () => ({ ok: true }), match: () => [] } };
    let result = await rebuildClone({ ...options, readyOnly });
    const deferred = readyOnly ? { recorded: result.readyRecorded === true,
      head: git(root, ['rev-parse', 'HEAD']), registered: readOverlays(root, { env }).length } : null;
    if (readyOnly) result = await rebuildClone({ ...options, adoptOnly: true });
    return { reason: result.reason, adopted: result.adopted === true, onMain: git(root, ['rev-parse', 'HEAD']) === main,
      dropped: readOverlays(root, { env }).length === 0, adoptedState: readRebuildState(root, env).adopted?.head === main,
      checks, errors, deferred: deferred && { ...deferred, unchanged: deferred.head === previous } };
  } finally { rmSync(base, { recursive: true, force: true }); }
}
