/**
 * @file scripts/lib/__tests__/daemon-overlays.test.mjs
 * @description Module B — the per-clone overlay list (`../daemon-overlays.mjs`) and its CLI
 *   (`../../daemon-overlay.mjs`). Every test points `WE_DAEMON_OVERLAY_DIR` at a fresh mkdtemp dir — never
 *   `~/.claude/*` — per the design's top rule that no state/lock dir may be written outside an injected temp
 *   path during tests. Most CLI tests still pass `--no-lock` (a harmless no-op — see `#4229/#2760 follow-up`
 *   below and `daemon-overlay.mjs`'s own file header): the CLI never imports `daemon-clone-lock.mjs` (Module A)
 *   at all any more, with or without that flag.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  cloneKey,
  overlayFilePath,
  readOverlays,
  readOverlayState,
  writeOverlays,
  addOverlay,
  removeOverlay,
  appendOverlayEvent,
  recordEdgeResolution,
} from '../daemon-overlays.mjs';

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'daemon-overlay.mjs');

let overlayDir;
let cloneRoot;

beforeEach(() => {
  overlayDir = mkdtempSync(join(tmpdir(), 'we-daemon-overlays-'));
  cloneRoot = mkdtempSync(join(tmpdir(), 'we-daemon-overlays-clone-'));
});

afterEach(() => {
  rmSync(overlayDir, { recursive: true, force: true });
  rmSync(cloneRoot, { recursive: true, force: true });
});

function env() {
  return { WE_DAEMON_OVERLAY_DIR: overlayDir };
}

// ── real-git fixture (epic #3383/#4075 overlay-conflict guard) ─────────────────────────────────────────────
// The CLI's `add` now resolves `--ref` for real (`previewOverlayConflict`) before registering it, so any test
// that exercises `add` through the CLI needs a REAL git clone with a REAL origin and, for a specific `--ref`,
// a REAL branch of that name — a plain empty directory (the bare `cloneRoot` above, still used by every OTHER
// describe block that never touches the CLI's `add`) no longer suffices. All-local (bare `origin.git` + a
// working clone, no network), so this stays fast and hermetic.
function git(cwd, args) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
  });
}
function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
function makeGitClone() {
  const base = mkdtempSync(join(tmpdir(), 'we-daemon-overlays-git-'));
  const originDir = join(base, 'origin.git');
  const cloneDir = join(base, 'clone');
  gitOk(base, ['init', '--bare', '-q', originDir]);
  gitOk(base, ['init', '-q', '-b', 'main', cloneDir]);
  writeFileSync(join(cloneDir, 'README.md'), 'init\n');
  gitOk(cloneDir, ['add', 'README.md']);
  gitOk(cloneDir, ['commit', '-q', '-m', 'init']);
  gitOk(cloneDir, ['remote', 'add', 'origin', originDir]);
  gitOk(cloneDir, ['push', '-q', '-u', 'origin', 'main']);
  return { base, originDir, cloneDir };
}
/** Push one throwaway commit onto `ref` (branched from origin/main), via a throwaway clone of `originDir` —
 *  never through `cloneDir`, so the clone under test stays clean. */
function pushRef(originDir, ref) {
  const dir = join(mkdtempSync(join(tmpdir(), 'we-daemon-overlays-author-')), 'w');
  gitOk(dirname(dir), ['clone', '-q', originDir, dir]);
  // Branch from `origin/main` EXPLICITLY, never from the clone's checked-out HEAD: `origin.git` is a bare
  // `git init` whose HEAD follows the host's `init.defaultBranch` — `master` on a CI runner with no such config
  // — so a plain clone checks out nothing, `-b` would make an unrelated orphan branch, and the guard's
  // `merge-tree` would then fail on unrelated histories (CI-only: macOS's system gitconfig sets `main`).
  gitOk(dir, ['checkout', '-q', '-b', ref, 'origin/main']);
  writeFileSync(join(dir, `${ref.replace(/\//g, '-')}.txt`), 'x\n');
  gitOk(dir, ['add', '.']);
  gitOk(dir, ['commit', '-q', '-m', `overlay: ${ref}`]);
  gitOk(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
}

describe('cloneKey / overlayFilePath', () => {
  it('is deterministic and filesystem-safe', () => {
    const k1 = cloneKey(cloneRoot);
    const k2 = cloneKey(cloneRoot);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('collides across different spellings of the same real path', () => {
    const spelled = join(cloneRoot, '.', 'x', '..');
    expect(cloneKey(spelled)).toBe(cloneKey(cloneRoot));
  });

  it('overlayFilePath sits under the env-pinned dir, keyed by cloneKey', () => {
    const file = overlayFilePath(cloneRoot, { WE_DAEMON_OVERLAY_DIR: overlayDir });
    expect(file).toBe(join(overlayDir, `${cloneKey(cloneRoot)}.json`));
  });
});

describe('readOverlays / readOverlayState', () => {
  it('missing file ⇒ [] and corrupt:false, never throws', () => {
    expect(readOverlays(cloneRoot, { env: env() })).toEqual([]);
    expect(readOverlayState(cloneRoot, { env: env() })).toEqual({ clone: null, overlays: [], corrupt: false });
  });

  it('corrupt (unparsable) file ⇒ [] and corrupt:true, never throws', () => {
    writeFileSync(overlayFilePath(cloneRoot, env()), '{not json', 'utf8');
    expect(() => readOverlays(cloneRoot, { env: env() })).not.toThrow();
    expect(readOverlays(cloneRoot, { env: env() })).toEqual([]);
    expect(readOverlayState(cloneRoot, { env: env() }).corrupt).toBe(true);
  });

  it('addOverlay / removeOverlay throw on a corrupt file instead of overwriting it with a fresh list', () => {
    const file = overlayFilePath(cloneRoot, env());
    writeFileSync(file, '{not json', 'utf8');
    expect(() => addOverlay(cloneRoot, { ref: 'lane/x' }, { env: env() })).toThrow(/corrupt/);
    expect(() => removeOverlay(cloneRoot, 'lane/x', { env: env() })).toThrow(/corrupt/);
    expect(readFileSync(file, 'utf8')).toBe('{not json');
  });

  it('wrong-shaped JSON (overlays not an array) ⇒ [] and corrupt:true', () => {
    writeFileSync(overlayFilePath(cloneRoot, env()), JSON.stringify({ clone: cloneRoot, overlays: 'nope' }), 'utf8');
    const state = readOverlayState(cloneRoot, { env: env() });
    expect(state.corrupt).toBe(true);
    expect(state.overlays).toEqual([]);
  });
});

describe('writeOverlays', () => {
  it('is atomic — no leftover tmp file after a write', () => {
    writeOverlays(cloneRoot, [{ ref: 'lane/x', pr: null, addedAt: 'now', addedBy: 'a', reason: null }], { env: env() });
    const entries = readdirSync(overlayDir);
    expect(entries.some((f) => f.includes('.tmp-'))).toBe(false);
    expect(readOverlays(cloneRoot, { env: env() })).toHaveLength(1);
  });

  it('records the resolved clone path in the file', () => {
    writeOverlays(cloneRoot, [], { env: env() });
    const state = readOverlayState(cloneRoot, { env: env() });
    expect(state.clone).toBe(realpathSync(cloneRoot));
  });
});

describe('addOverlay', () => {
  it('adds a new entry', () => {
    const list = addOverlay(cloneRoot, { ref: 'lane/foo', pr: 12, addedBy: 'nic', reason: 'fix' }, { env: env() });
    expect(list).toEqual([{ ref: 'lane/foo', pr: 12, addedAt: expect.any(String), addedBy: 'nic', reason: 'fix' }]);
  });

  it('duplicate ref updates pr/reason in place and keeps position + original addedAt/addedBy', () => {
    addOverlay(cloneRoot, { ref: 'lane/a', pr: 1, addedBy: 'nic', now: '2026-01-01T00:00:00.000Z' }, { env: env() });
    addOverlay(cloneRoot, { ref: 'lane/b', pr: 2, addedBy: 'nic', now: '2026-01-02T00:00:00.000Z' }, { env: env() });
    const list = addOverlay(cloneRoot, { ref: 'lane/a', pr: 99, addedBy: 'someone-else', reason: 'updated' }, { env: env() });
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ ref: 'lane/a', pr: 99, reason: 'updated', addedAt: '2026-01-01T00:00:00.000Z', addedBy: 'nic' });
    expect(list[1]).toMatchObject({ ref: 'lane/b', pr: 2 });
  });

  it('rejects an unsafe ref without writing anything', () => {
    expect(() => addOverlay(cloneRoot, { ref: '--upload-pack=evil' }, { env: env() })).toThrow(TypeError);
    expect(readOverlays(cloneRoot, { env: env() })).toEqual([]);
  });
});

describe('removeOverlay', () => {
  it('removes an existing ref', () => {
    addOverlay(cloneRoot, { ref: 'lane/a' }, { env: env() });
    addOverlay(cloneRoot, { ref: 'lane/b' }, { env: env() });
    const result = removeOverlay(cloneRoot, 'lane/a', { env: env() });
    expect(result.removed).toBe(true);
    expect(result.list.map((o) => o.ref)).toEqual(['lane/b']);
  });

  it('is idempotent — removing an absent ref is not an error', () => {
    const result = removeOverlay(cloneRoot, 'lane/nope', { env: env() });
    expect(result).toEqual({ removed: false, list: [] });
  });
});

describe('recordEdgeResolution', () => {
  const SHA = 'a'.repeat(40);

  it('records actor + sha on a registered overlay, keeps it across a re-add, and leaves an audit event', () => {
    addOverlay(cloneRoot, { ref: 'lane/a' }, { env: env() });
    const list = recordEdgeResolution(cloneRoot, 'lane/a', { sha: SHA, by: ' operator ', reason: 'reviewed', now: '2026-10-05T00:00:00Z' }, { env: env() });
    expect(list[0].edgeResolution).toEqual({ sha: SHA, by: 'operator', at: '2026-10-05T00:00:00Z', reason: 'reviewed' });
    addOverlay(cloneRoot, { ref: 'lane/a', pr: 9 }, { env: env() });
    expect(readOverlays(cloneRoot, { env: env() })[0].edgeResolution.sha).toBe(SHA);
    const events = readFileSync(join(overlayDir, `${cloneKey(cloneRoot)}.events.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ kind: 'edge-resolution-recorded', ref: 'lane/a', sha: SHA, by: 'operator' });
  });

  it('refuses a malformed sha, a missing actor and an unregistered overlay without writing anything', () => {
    addOverlay(cloneRoot, { ref: 'lane/a' }, { env: env() });
    for (const bad of [{ sha: 'abc123', by: 'op' }, { sha: SHA.toUpperCase(), by: 'op' }, { sha: SHA, by: '' }, { sha: SHA }]) {
      expect(() => recordEdgeResolution(cloneRoot, 'lane/a', bad, { env: env() })).toThrow(TypeError);
    }
    expect(() => recordEdgeResolution(cloneRoot, 'lane/nope', { sha: SHA, by: 'op' }, { env: env() })).toThrow(/not registered/);
    expect(readOverlays(cloneRoot, { env: env() })[0].edgeResolution).toBeUndefined();
  });

  it('is dropped together with the overlay entry', () => {
    addOverlay(cloneRoot, { ref: 'lane/a' }, { env: env() });
    recordEdgeResolution(cloneRoot, 'lane/a', { sha: SHA, by: 'op' }, { env: env() });
    removeOverlay(cloneRoot, 'lane/a', { env: env() });
    addOverlay(cloneRoot, { ref: 'lane/a' }, { env: env() });
    expect(readOverlays(cloneRoot, { env: env() })[0].edgeResolution).toBeUndefined();
  });
});

describe('appendOverlayEvent', () => {
  it('appends one JSON line with an `at` stamp per call', () => {
    appendOverlayEvent(cloneRoot, { kind: 'added', ref: 'lane/a' }, { env: env() });
    appendOverlayEvent(cloneRoot, { kind: 'removed', ref: 'lane/a' }, { env: env() });
    const file = join(overlayDir, `${cloneKey(cloneRoot)}.events.jsonl`);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const events = lines.map((l) => JSON.parse(l));
    expect(events[0]).toMatchObject({ kind: 'added', ref: 'lane/a' });
    expect(events[1]).toMatchObject({ kind: 'removed', ref: 'lane/a' });
    expect(typeof events[0].at).toBe('string');
  });
});

describe('CLI (spawnSync, --no-lock — never imports daemon-clone-lock.mjs)', () => {
  function run(args) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, WE_DAEMON_OVERLAY_DIR: overlayDir },
      timeout: 20_000,
    });
  }

  it('add --no-lock --json registers the ref and appends an event', () => {
    const { originDir, cloneDir } = makeGitClone();
    pushRef(originDir, 'lane/cli-test');
    const r = run(['add', `--clone=${cloneDir}`, '--ref=lane/cli-test', '--pr=7', '--by=tester', '--no-lock', '--json']);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.list).toEqual([{ ref: 'lane/cli-test', pr: 7, addedAt: expect.any(String), addedBy: 'tester', reason: null }]);
    const events = readFileSync(join(overlayDir, `${cloneKey(cloneDir)}.events.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'added', ref: 'lane/cli-test', pr: 7 });
  });

  it('list --json reflects what add wrote', () => {
    const { originDir, cloneDir } = makeGitClone();
    pushRef(originDir, 'lane/cli-test');
    run(['add', `--clone=${cloneDir}`, '--ref=lane/cli-test', '--no-lock']);
    const r = run(['list', `--clone=${cloneDir}`, '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).list.map((o) => o.ref)).toEqual(['lane/cli-test']);
  });

  it('remove --no-lock --json drops the ref and appends a removed event', () => {
    const { originDir, cloneDir } = makeGitClone();
    pushRef(originDir, 'lane/cli-test');
    run(['add', `--clone=${cloneDir}`, '--ref=lane/cli-test', '--no-lock']);
    const r = run(['remove', `--clone=${cloneDir}`, '--ref=lane/cli-test', '--no-lock', '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toEqual({ removed: true, list: [] });
    const events = readFileSync(join(overlayDir, `${cloneKey(cloneDir)}.events.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events.map((e) => e.kind)).toEqual(['added', 'removed']);
  });

  it('approve-edge records the approval for a registered overlay and rejects bad input with exit 2', () => {
    const { originDir, cloneDir } = makeGitClone();
    pushRef(originDir, 'lane/cli-test');
    run(['add', `--clone=${cloneDir}`, '--ref=lane/cli-test', '--no-lock']);
    const sha = 'b'.repeat(40);
    const ok = run(['approve-edge', `--clone=${cloneDir}`, '--ref=lane/cli-test', `--sha=${sha}`, '--by=tester', '--reason=reviewed', '--json']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout).list[0].edgeResolution).toMatchObject({ sha, by: 'tester', reason: 'reviewed' });
    for (const args of [
      ['--ref=lane/cli-test', '--sha=abc', '--by=tester'],
      ['--ref=lane/never-added', `--sha=${sha}`, '--by=tester'],
      ['--ref=lane/cli-test', '--by=tester'],
    ]) {
      const bad = run(['approve-edge', `--clone=${cloneDir}`, ...args]);
      expect(bad.status).toBe(2);
    }
  });

  // Advisory 2026-09-25 (PR #2625): a corrupt file read as an empty list everywhere, silently.
  it('list on a corrupt file reports corrupt:true and exits 1, add/remove refuse and leave the file untouched', () => {
    const file = overlayFilePath(cloneRoot, env());
    writeFileSync(file, '{not json', 'utf8');
    const listed = run(['list', `--clone=${cloneRoot}`, '--json']);
    expect(listed.status).toBe(1);
    expect(JSON.parse(listed.stdout)).toEqual({ list: [], corrupt: true });
    for (const args of [['add', '--ref=lane/x'], ['remove', '--ref=lane/x']]) {
      const r = run([...args, `--clone=${cloneRoot}`, '--no-lock', '--json']);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/corrupt/);
    }
    expect(readFileSync(file, 'utf8')).toBe('{not json');
  });

  it('bad usage exits 2 and never writes anything', () => {
    const r = run(['add', `--clone=${cloneRoot}`, '--no-lock']); // missing --ref
    expect(r.status).toBe(2);
    expect(readdirSync(overlayDir)).toEqual([]);
  });

  it('unknown command exits 2', () => {
    const r = run(['bogus', `--clone=${cloneRoot}`]);
    expect(r.status).toBe(2);
  });
});

// ── #4229/#2760 follow-up (live 2026-09-26): `add` used to take the clone's WRITE lock and was refused
// (`concurrent-mover`) whenever the daemon's own rebuild already held it — live 4 times in a row on PR #2760.
// register-only `add`/`remove` must never even LOOK at the clone's reader/writer lock, so it must succeed at
// once regardless of what (if anything) holds it.
describe('register-only: never contends for the clone write lock (#4229/#2760 follow-up)', () => {
  it('add succeeds near-instantly and registers the ref while a REAL writer lock is held on the clone', async () => {
    const { originDir, cloneDir } = makeGitClone();
    pushRef(originDir, 'lane/4229-pr-2760');
    const { acquireWrite, releaseWrite } = await import('../daemon-clone-lock.mjs');
    const lockRoot = mkdtempSync(join(tmpdir(), 'we-daemon-clone-lock-'));
    try {
      const acquired = await acquireWrite(cloneDir, { lockRoot, owner: 'test-rebuild:1' });
      expect(acquired.ok).toBe(true);
      try {
        const startedAt = Date.now();
        const r = spawnSync(process.execPath, [
          CLI_PATH, 'add', `--clone=${cloneDir}`, '--ref=lane/4229-pr-2760', '--pr=2760', '--json',
        ], {
          encoding: 'utf8',
          env: { ...process.env, WE_DAEMON_OVERLAY_DIR: overlayDir, WE_DAEMON_CLONE_LOCK_ROOT: lockRoot },
          timeout: 20_000,
        });
        const elapsed = Date.now() - startedAt;
        expect(r.status, r.stderr).toBe(0);
        expect(elapsed).toBeLessThan(5_000);
        expect(JSON.parse(r.stdout).list.map((o) => o.ref)).toEqual(['lane/4229-pr-2760']);
      } finally {
        releaseWrite(cloneDir, { lockRoot, owner: 'test-rebuild:1' });
      }
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  it('never imports daemon-clone-lock.mjs at all any more (docs may still mention it by name)', () => {
    const src = readFileSync(CLI_PATH, 'utf8');
    expect(src).not.toMatch(/import\(.*daemon-clone-lock|from\s+['"].*daemon-clone-lock/);
  });
});

describe('pinned overlays (self-destruct guard, 2026-09-25)', () => {
  it('addOverlay records pinned:true, keeps it on a plain re-add, and clears it with pinned:false', () => {
    const env = { WE_DAEMON_OVERLAY_DIR: overlayDir };
    addOverlay(cloneRoot, { ref: 'lane/mech', pr: 1, pinned: true }, { env });
    expect(readOverlays(cloneRoot, { env })[0].pinned).toBe(true);
    addOverlay(cloneRoot, { ref: 'lane/mech', pr: 1 }, { env });
    expect(readOverlays(cloneRoot, { env })[0].pinned).toBe(true);
    addOverlay(cloneRoot, { ref: 'lane/mech', pr: 1, pinned: false }, { env });
    expect(readOverlays(cloneRoot, { env })[0].pinned).toBeUndefined();
  });

  it('CLI add --pinned writes pinned:true', () => {
    const { originDir, cloneDir } = makeGitClone();
    pushRef(originDir, 'lane/mech');
    const r = spawnSync(process.execPath, [CLI_PATH, 'add', `--clone=${cloneDir}`, '--ref=lane/mech', '--pinned', '--no-lock', '--json'], {
      encoding: 'utf8', env: { ...process.env, WE_DAEMON_OVERLAY_DIR: overlayDir },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).list[0]).toMatchObject({ ref: 'lane/mech', pinned: true });
  });
});
