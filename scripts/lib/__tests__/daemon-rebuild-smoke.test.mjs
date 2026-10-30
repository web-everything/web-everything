/** @file xhiqxz3 — the daemon's TICK rebuild runs the real dispatch smoke (#4481's) inside its candidate smoke, so
 * an overlay that breaks the worker launch is never adopted. Real-git fixtures; the worker launch is injected. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rebuildClone, readRebuildState } from '../daemon-rebuild.mjs';
import { addOverlay, overlayFilePath, readOverlayState, removeOverlay } from '../daemon-overlays.mjs';
import { dispatchSmokeSuspects, smokeAndAdopt, smokeFailureFiles } from '../daemon-rebuild/smoke.mjs';
import { checkDaemonEntriesBoot, DAEMON_ENTRIES_ENV } from '../daemon-boot-smoke.mjs';
import { runRealDispatchSmoke } from '../daemon-load-overlay.mjs';
import { alertsFilePath } from '../daemon-rebuild/state.mjs';
import { replayFallbackRegistration } from '../../conveyor/soak/breaks/overlay-fallback-registration.mjs';

process.env.WE_DAEMON_REBUILD_SKIP_UNRELATED = '0';

const tempDirs = [];
function mktemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
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
function writeFile(dir, name, content) {
  const full = join(dir, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
function pushBranch(originDir, ref, mutate, from = 'origin/main') {
  const dir = join(mktemp('we-rebuild-dsmoke-author-'), 'w');
  const r = spawnSync('git', ['clone', '-q', originDir, dir], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
  if (r.status !== 0) throw new Error(`clone failed: ${r.stderr}`);
  gitOk(dir, ['checkout', '-q', '-B', ref, from]);
  mutate(dir);
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '-q', '-m', `change: ${ref}`]);
  gitOk(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
  return gitOk(dir, ['rev-parse', 'HEAD']).trim();
}

function makeFixture() {
  const base = mktemp('we-rebuild-dsmoke-fixture-');
  const originDir = join(base, 'origin.git');
  const cloneDir = join(base, 'clone');
  mkdirSync(cloneDir, { recursive: true });
  gitOk(base, ['init', '--bare', '-q', originDir]);
  gitOk(cloneDir, ['init', '-q', '-b', 'main']);
  writeFile(cloneDir, 'README.md', 'init\n');
  writeFile(cloneDir, 'scripts/operations/dispatch-lane-io.mjs', 'export const v = 1;\n');
  gitOk(cloneDir, ['add', '-A']);
  gitOk(cloneDir, ['commit', '-q', '-m', 'init']);
  gitOk(cloneDir, ['remote', 'add', 'origin', originDir]);
  gitOk(cloneDir, ['push', '-q', '-u', 'origin', 'main']);
  gitOk(cloneDir, ['fetch', '-q', 'origin']);
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: mktemp('we-rebuild-dsmoke-state-'),
    WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-rebuild-dsmoke-lock-'),
    WE_DAEMON_OVERLAY_DIR: mktemp('we-rebuild-dsmoke-overlay-'),
  };
  return { originDir, cloneDir, env };
}

const LOCK_OPTS = { waitMs: 1500, pollMs: 20 };
const PASS = { verdict: 'pass', attempts: 1, smoke: { results: [] } };
const SETTINGS = {
  dispatchSmoke: 'on', dispatchPaths: ['scripts/operations/dispatch-lane-io.mjs'], noPr: 'warn', smokeTimeoutMs: 60_000, smokeKind: 'ci-heal',
};
const head = (f) => gitOk(f.cloneDir, ['rev-parse', 'HEAD']).trim();
const rebuild = (f, run, { settings = SETTINGS, runSmoke = vi.fn(async () => PASS) } = {}) => rebuildClone({
  root: f.cloneDir, env: f.env, runSmoke, prState: async () => null, lockOpts: LOCK_OPTS,
  dispatchSmoke: { settings, run },
});
function addDispatchOverlay(f, ref = 'lane/s3b', file = 'scripts/operations/dispatch-lane-io.mjs') {
  const sha = pushBranch(f.originDir, ref, (dir) => writeFile(dir, file, `export const v = '${ref}';\n`));
  addOverlay(f.cloneDir, { ref, pr: 77, addedBy: 't' }, { env: f.env });
  return sha;
}
const refs = (f) => readOverlayState(f.cloneDir, { env: f.env }).overlays.map((o) => o.ref);

describe('fallback registration evidence', () => {
  for (const selective of [false, true]) for (const recovery of [false, true]) {
    it(`fallback adoption preserves retained mechanism registration evidence across refresh failure (${selective ? 'selective' : 'plain'}, ${recovery ? 'recovered' : 'direct'})`, async () => {
      expect((await replayFallbackRegistration({ selective, recovery })).violations).toEqual([]);
    }, 30_000);
  }
  for (const selective of [false, true]) {
    it(`fallback adoption does not bind old mechanism evidence to a replacement registration (${selective ? 'selective' : 'plain'})`, async () => {
      expect((await replayFallbackRegistration({ selective, replace: true })).violations).toEqual([]);
    }, 30_000);
  }
});

beforeEach(() => { tempDirs.length = 0; });
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('xhiqxz3 — dispatch smoke inside the tick rebuild', () => {
  // Operator decision (PR 5460, 2026-10-17): smoke failure details, held state and self-sync alerts carry an
  // allow-listed summary (typed fields, the error class, the 0600 stderr file's path), never raw child text. The
  // sentinel words below are not secret-shaped, so only the design (never a redactor) can keep them out.
  const sinksOf = (f, result) => {
    const dir = f.env.WE_DAEMON_OVERLAY_DIR;
    const events = readdirSync(dir).filter((n) => n.endsWith('.events.jsonl')).map((n) => readFileSync(join(dir, n), 'utf8'));
    return [JSON.stringify(result.alerts), JSON.stringify(readRebuildState(f.cloneDir, f.env)),
      readFileSync(alertsFilePath(f.cloneDir, f.env), 'utf8'), ...events];
  };
  const expectAbsent = (sinks, words) => { for (const w of words) for (const s of sinks) expect(s).not.toContain(w); };

  it('a boot failure reaches held state and self-sync alerts as its summary only; the tail is a 0600 file under the state dir', async () => {
    const f = makeFixture();
    addDispatchOverlay(f);
    const frames = Array.from({ length: 30 }, (_, i) => `native stack frame${i}x`);
    const stderr = ['warning alphaword1x', 'TypeError: load failed for "password: bravoword2x', 'charlieword3x"', ...frames].join('\n');
    const boot = await checkDaemonEntriesBoot({ root: f.cloneDir, log: { error() {} },
      // No diagnosticsDir: the default, `<WE_DAEMON_STATE_DIR>/smoke-diagnostics`.
      env: { [DAEMON_ENTRIES_ENV]: 'fixture.mjs', WE_DAEMON_STATE_DIR: f.env.WE_DAEMON_STATE_DIR },
      runChild: async () => { throw Object.assign(new Error('exited null: warning alphaword1x'), { signal: 'SIGTRAP', status: null, stderr }); },
    });
    const result = await rebuildClone({ root: f.cloneDir,
      env: { ...f.env, WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE: '0' },
      prState: async () => null, lockOpts: LOCK_OPTS, log: { error() {} },
      runSmoke: async () => ({ verdict: 'code', smoke: { results: [{ name: 'daemon-entries-boot', ...boot }] } }),
    });
    expect(result.adopted).toBeFalsy();
    const held = readRebuildState(f.cloneDir, f.env).held;
    expect(held.details[0].detail).toContain('fixture.mjs: child failed (signal=SIGTRAP, exitCode=null, attempts=2');
    expect(held.details[0].detail).toContain('class=TypeError: load failed for <…>');
    const file = boot.entries[0].stderrFile;
    expect(dirname(file)).toBe(join(f.env.WE_DAEMON_STATE_DIR, 'smoke-diagnostics'));
    expect(held.details[0].detail).toContain(`stderr=${file}`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe(`${stderr.split('\n').slice(-30).join('\n')}\n`);
    const alert = result.alerts.find((a) => a.kind === 'daemon-held-on-last-good');
    expect(alert.detail.details).toEqual(held.details);
    const stale = result.alerts.find((a) => a.kind === 'clone-held-stale');
    expect(stale.detail.broken.details).toEqual(held.details);
    expectAbsent(sinksOf(f, result), ['alphaword1x', 'bravoword2x', 'charlieword3x', 'native stack', 'frame29x']);
  });

  it('six failed boot entries each keep name, signal, exit code and class within the boot detail cap', async () => {
    const f = makeFixture();
    addDispatchOverlay(f);
    const entries = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `skills-src/conveyor/some-long-daemon-entry-name-${x}.mjs`);
    const boot = await checkDaemonEntriesBoot({ root: f.cloneDir, log: { error() {} },
      env: { [DAEMON_ENTRIES_ENV]: entries.join(','), WE_DAEMON_STATE_DIR: f.env.WE_DAEMON_STATE_DIR },
      runChild: async () => { throw Object.assign(new Error(`exited 1: ${'m'.repeat(900)}`), {
        signal: null, status: 1, stderr: `RangeError: ${'q'.repeat(200)}\n${'cr\r'.repeat(5_000)}\nkiloword4x`,
      }); },
    });
    const result = await rebuildClone({ root: f.cloneDir,
      env: { ...f.env, WE_DAEMON_HARNESS_BROKEN_ADOPT_NOT_WORSE: '0' },
      prState: async () => null, lockOpts: LOCK_OPTS, log: { error() {} },
      runSmoke: async () => ({ verdict: 'code', smoke: { results: [{ name: 'daemon-entries-boot', ...boot }] } }),
    });
    const text = readRebuildState(f.cloneDir, f.env).held.details[0].detail;
    for (const entry of entries) expect(text).toContain(`${entry}: child failed (signal=null, exitCode=1, attempts=1`);
    expect(text.match(/ stderr=\S+ class=RangeError: q{68}$/gm)).toHaveLength(6);
    expect(text.length).toBeLessThanOrEqual(4_000);
    expectAbsent(sinksOf(f, result), ['kiloword4x', 'mmmmmmmm', 'q'.repeat(69)]);
  });

  it('a boot failure still names its culprit files: typed paths read from the raw text in-process, not from the summary', async () => {
    const root = '/tmp/work';
    const stderr = [
      'file:///tmp/work/scripts/conveyor/review.mjs:20',
      "SyntaxError: The requested module '../takeover-budget.mjs' does not provide an export named 'x'",
      'file:///etc/outside.mjs:1',
    ].join('\n');
    const boot = await checkDaemonEntriesBoot({ root, log: { error() {} }, diagnosticsDir: mktemp('we-rebuild-dsmoke-diag-'),
      env: { [DAEMON_ENTRIES_ENV]: 'fixture.mjs', WE_SMOKE_BOOT_SIGNAL_RETRIES: '0' },
      runChild: async () => { throw Object.assign(new Error('exited 1'), { status: 1, signal: null, stderr }); },
    });
    expect(boot.detail).not.toContain('review.mjs');
    expect(boot.entries[0].files).toEqual(['scripts/conveyor/review.mjs', 'scripts/takeover-budget.mjs']);
    expect(smokeFailureFiles([{ name: 'daemon-entries-boot', ...boot }], { candidatePath: root }))
      .toEqual(['scripts/conveyor/review.mjs', 'scripts/takeover-budget.mjs']);
    // A typed path outside the plain repo-relative shape is ignored.
    expect(smokeFailureFiles([{ detail: '', entries: [{ files: ['../x.mjs', 'a b.mjs', 'ok/y.mjs'] }] }], { candidatePath: root })).toEqual(['ok/y.mjs']);
  });

  /** The real dispatch smoke, its worker launch injected: `onLaunch` plays the launched worker. */
  const realDispatch = (f, onLaunch) => (args) => runRealDispatchSmoke({
    ...args, settings: { ...args.settings, smokeTimeoutMs: 0 }, pollMs: 1, probeAlive: () => false, home: join(f.env.WE_DAEMON_STATE_DIR, 'home'),
    log: { error() {} },
    spawn: (_node, argv) => {
      const [, , , , , sessionId, , , scratch] = argv;
      onLaunch({ sessionId, scratch });
      return { status: 0, stdout: JSON.stringify({ handle: 'pid:12345', wrapperPid: 12345 }), stderr: '' };
    },
  });

  it('a dispatch-smoke timeout alert carries the allow-listed diagnostics only; each attempt\'s tail is a 0600 file', async () => {
    const f = makeFixture();
    addDispatchOverlay(f);
    const stderr = ['booting limaword5x', 'SyntaxError: bad config "API_KEY=mikeword6x', 'novemberword7x"', 'progress\roscarword8x'].join('\n');
    const r = await rebuild(f, realDispatch(f, ({ scratch }) => writeFileSync(join(scratch, 'wrapper.stderr'), stderr)));
    expect(r.adopted).toBeFalsy();
    const alert = r.alerts.find((a) => a.kind === 'dispatch-smoke-failed').detail;
    expect(alert).toMatchObject({ reason: 'timeout', action: 'retry-with-backoff' });
    expect(Object.keys(alert.diagnostics).sort()).toEqual(['attempts', 'errorClass', 'exitCode', 'firstOutputMs', 'launchStartedAt', 'sessionAppeared',
      'signal', 'stderrFile', 'transcriptAppeared', 'wrapperAliveAtTimeout', 'wrapperPid']);
    expect(alert.diagnostics).toMatchObject({ errorClass: 'SyntaxError: bad config <…>', wrapperPid: 12345, sessionAppeared: false });
    expect(alert.attempts).toHaveLength(2);
    for (const a of alert.attempts) {
      expect(statSync(a.diagnostics.stderrFile).mode & 0o777).toBe(0o600);
      expect(dirname(a.diagnostics.stderrFile)).toBe(join(f.env.WE_DAEMON_STATE_DIR, 'smoke-diagnostics'));
      expect(readFileSync(a.diagnostics.stderrFile, 'utf8')).toContain('oscarword8x');
    }
    expectAbsent(sinksOf(f, r), ['limaword5x', 'mikeword6x', 'novemberword7x', 'oscarword8x', 'booting']);
  });

  it('a definite dispatch-smoke failure (a transcript denial) drops the overlay with no worker text in any sink', async () => {
    const f = makeFixture();
    addDispatchOverlay(f);
    const body = 'This command requires approval: deploy --password "papaword9x\nquebecword10x"';
    const r = await rebuild(f, realDispatch(f, ({ sessionId }) => {
      const dir = join(f.env.WE_DAEMON_STATE_DIR, 'home', '.claude', 'projects', 'test');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: body }] } }));
    }));
    expect(r.adopted).toBeFalsy();
    expect(refs(f)).toEqual([]);
    const alert = r.alerts.find((a) => a.kind === 'dispatch-smoke-failed').detail;
    expect(alert).toMatchObject({ reason: 'commands-denied', action: 'dropped-suspects' });
    expect(alert.detail).toMatch(/^1 denied tool call\(s\) in the transcript; /);
    expectAbsent(sinksOf(f, r), ['requires approval', 'deploy', 'papaword9x', 'quebecword10x']);
  });

  it('an injected result cannot push free text through the alert diagnostics', async () => {
    const f = makeFixture();
    addDispatchOverlay(f);
    const diagnostics = { stderrTail: 'romeoword11x', errorClass: 'TypeError: x\nsierraword12x', launchStartedAt: 'tangoword13x', wrapperPid: 42 };
    const r = await rebuild(f, async () => ({ ok: false, reason: 'timeout', detail: 'no command ran and no completion record', diagnostics, attempts: [{ reason: 'timeout', diagnostics, extra: 'uniformword14x' }] }));
    const alert = r.alerts.find((a) => a.kind === 'dispatch-smoke-failed').detail;
    expect(alert.diagnostics).toMatchObject({ wrapperPid: 42, errorClass: null, launchStartedAt: null });
    expect(alert.diagnostics).not.toHaveProperty('stderrTail');
    expect(alert.attempts).toEqual([{ reason: 'timeout', diagnostics: alert.diagnostics }]);
    expectAbsent(sinksOf(f, r), ['romeoword11x', 'sierraword12x', 'tangoword13x', 'uniformword14x']);
  });

  it('a candidate whose new overlay fails the dispatch smoke is never adopted; the clone stays on last-good', async () => {
    const f = makeFixture();
    const lastGood = head(f);
    addOverlay(f.cloneDir, { ref: 'lane/other', pr: 5, addedBy: 't' }, { env: f.env });
    pushBranch(f.originDir, 'lane/other', (dir) => writeFile(dir, 'other.txt', 'x'));
    addDispatchOverlay(f);
    const run = vi.fn(async () => ({ ok: false, reason: 'commands-denied', detail: 'This command requires approval' }));
    const r = await rebuild(f, run);
    expect(run).toHaveBeenCalledTimes(1);
    // It smokes the CANDIDATE worktree, never the live clone.
    expect(run.mock.calls[0][0].tree).not.toBe(f.cloneDir);
    expect(r.adopted).toBeFalsy();
    expect(r.reason).toBe('dispatch-smoke-failed');
    expect(head(f)).toBe(lastGood);
    const st = readRebuildState(f.cloneDir, f.env);
    expect(st.held.reason).toBe('dispatch-smoke-failed');
    // Only the offending overlay is dropped; the other one stays registered.
    expect(refs(f)).toEqual(['lane/other']);
    expect(r.alerts.map((a) => a.kind)).toContain('dispatch-smoke-failed');
    // The next tick builds main + the remaining overlay, with no dispatch smoke needed.
    const run2 = vi.fn(async () => ({ ok: true, reason: 'passed' }));
    const r2 = await rebuild(f, run2);
    expect(r2.adopted).toBe(true);
    expect(run2).not.toHaveBeenCalled();
  });

  it.each(['dispatch dry-run ok', 'dispatch dry-run failed (1/9): fix failed'])(
    'names slow passes in timings and alerts for %s', async (prefix) => {
      const f = makeFixture();
      addDispatchOverlay(f);
      const log = { error: vi.fn() };
      let clock = Date.now();
      const detail = `${prefix} — review 1ms, fix 0ms, reconcile-fix-pass 81.3s, reconcile-ci-heal-pass 41.8s, reconcile-review-pass 36.3s, boundary 1000ms, short 999ms, bad NaNs, fifth 2s, sixth 3s, seventh 4s`;
      const result = await rebuildClone({
        root: f.cloneDir, env: f.env, prState: async () => null, lockOpts: LOCK_OPTS,
        log, now: () => clock,
        runSmoke: async () => {
          clock += 65_000;
          return { verdict: 'pass', smoke: { results: [
            { name: 'dispatch-dry-run', ms: 495196, ok: true, detail },
            { name: 'reconcile-dry-run', ms: 229798, ok: true },
            { name: 'malformed', ms: 1, ok: true, detail: { timings: 'bad' } },
          ] } };
        },
        dispatchSmoke: { settings: SETTINGS, run: async () => ({ ok: true, reason: 'passed', ms: 5 }) },
      });
      const line = log.error.mock.calls.map(([message]) => message)
        .find(message => message.startsWith('daemon-rebuild: smoke-timings '));
      const payload = JSON.parse(line.slice('daemon-rebuild: smoke-timings '.length));
      const passes = { 'dispatch-dry-run': 'reconcile-fix-pass 81.3s, reconcile-ci-heal-pass 41.8s, reconcile-review-pass 36.3s, boundary 1000ms, fifth 2s, sixth 3s' };
      expect(payload.checks).toBe('dispatch-dry-run:495196ms reconcile-dry-run:229798ms malformed:1ms dispatch-smoke:5ms');
      expect(payload.passes).toEqual(passes);
      expect(result.alerts.find(alert => alert.kind === 'smoke-slow').detail).toEqual(payload);
    },
  );

  it('omits passes when no detail contains slow timing rows', async () => {
    const f = makeFixture();
    addDispatchOverlay(f);
    const log = { error: vi.fn() };
    await rebuildClone({
      root: f.cloneDir, env: f.env, prState: async () => null, lockOpts: LOCK_OPTS, log,
      runSmoke: async () => ({ verdict: 'pass', smoke: { results: [
        { name: 'missing', ms: 1, ok: true },
        { name: 'short', ms: 1, ok: true, detail: 'dispatch dry-run ok — review 1ms, fix 0ms' },
        { name: 'bad', ms: 1, ok: true, detail: 'review 2s' },
      ] } }),
      dispatchSmoke: { settings: SETTINGS, run: async () => ({ ok: true, reason: 'passed' }) },
    });
    const line = log.error.mock.calls.map(([message]) => message)
      .find(message => message.startsWith('daemon-rebuild: smoke-timings '));
    expect(JSON.parse(line.slice('daemon-rebuild: smoke-timings '.length))).not.toHaveProperty('passes');
  });

  it('a passing dispatch smoke adopts, and an unchanged overlay is not smoked again', async () => {
    const f = makeFixture();
    const sha = addDispatchOverlay(f);
    const run = vi.fn(async () => ({ ok: true, reason: 'passed', ms: 5 }));
    const r = await rebuild(f, run);
    expect(r.adopted).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.alerts.map((a) => a.kind)).toContain('dispatch-smoke-passed');
    gitOk(f.cloneDir, ['merge-base', '--is-ancestor', sha, 'HEAD']);
    pushBranch(f.originDir, 'main', (dir) => writeFile(dir, 'b.txt', 'b'));
    const r2 = await rebuild(f, run);
    expect(r2.adopted).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a timeout holds on last-good, keeps the overlay, and retries with backoff', async () => {
    const f = makeFixture();
    const lastGood = head(f);
    addDispatchOverlay(f);
    const run = vi.fn(async () => ({ ok: false, reason: 'timeout', detail: 'no command ran and no completion record' }));
    const r = await rebuild(f, run);
    expect(r.adopted).toBeFalsy();
    expect(head(f)).toBe(lastGood);
    expect(refs(f)).toEqual(['lane/s3b']);
    const st = readRebuildState(f.cloneDir, f.env);
    expect(st.rejected.dispatchSmoke).toBe(true);
    expect(Date.parse(st.rejected.retryAt)).toBeGreaterThan(Date.now());
    const r2 = await rebuild(f, run);
    expect(r2.reason).toBe('still-rejected');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('an overlay off the dispatch path, or the setting off, never launches a worker', async () => {
    const f = makeFixture();
    addDispatchOverlay(f, 'lane/docs', 'docs/x.md');
    const run = vi.fn();
    expect((await rebuild(f, run)).adopted).toBe(true);
    const g = makeFixture();
    addDispatchOverlay(g);
    expect((await rebuild(g, run, { settings: { ...SETTINGS, dispatchSmoke: 'off' } })).adopted).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  const FAIL = { verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'x', detail: 'boom' }] } };
  it('a failing ordinary smoke never reaches the dispatch smoke (plain main passes and is adopted)', async () => {
    const f = makeFixture();
    addDispatchOverlay(f);
    const run = vi.fn();
    const runSmoke = vi.fn().mockResolvedValueOnce(FAIL).mockResolvedValue(PASS);
    const r = await rebuild(f, run, { runSmoke });
    expect(r.reason).toBe('fallback-plain-main');
    expect(run).not.toHaveBeenCalled();
  });

  it('adopting a candidate "as no worse" (harness broken) still requires the dispatch smoke', async () => {
    const f = makeFixture();
    const lastGood = head(f);
    addDispatchOverlay(f);
    const run = vi.fn(async () => ({ ok: false, reason: 'no-commands-ran' }));
    const r = await rebuild(f, run, { runSmoke: vi.fn(async () => FAIL) });
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.reason).toBe('dispatch-smoke-failed');
    expect(head(f)).toBe(lastGood);
  });
});

describe('dispatch smoke registration CAS', () => {
  it('every rebuild removal carries registration CAS or the explicit auto-rebase snapshot allowlist', () => {
    const directory = join(process.cwd(), 'scripts/lib/daemon-rebuild');
    const calls = readdirSync(directory).filter(name => name.endsWith('.mjs')).flatMap(name => {
      const source = readFileSync(join(directory, name), 'utf8');
      return [...source.matchAll(/\bremoveOverlay\([^;]+\);/g)].map(match => ({ name, call: match[0] }));
    });
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const { name, call } of calls) {
      // Verified auto-rebase swaps use a complete saved oldOverlay identity (including registrationId)
      // plus requireRef. Keep this sole existing exception explicit; new call sites must carry id CAS.
      if (name === 'auto-rebase.mjs' && call.includes('removeOverlay(root, swap.old,')) {
        expect(call).toContain('expectedOverlay: swap.oldOverlay');
        expect(call).toContain('requireRef: swap.new');
      } else {
        expect(call, name).toContain('expectRegistrationId:');
      }
    }
  });

  // Exercise the real smokeAndAdopt removal branch and list/event storage. Only Git and the two
  // smoke runners are injected: this fixture neither creates a repository nor launches a worker.
  it.each([
    { name: 'drops a matching registration', token: 'matching', dropped: true },
    { name: 'preserves a replacement registration added during smoke', token: 'replaced', dropped: false },
    { name: 'preserves a suspect with a missing registration token', token: 'missing', dropped: false },
    { name: 'preserves a suspect with an undefined registration token', token: undefined, dropped: false },
    { name: 'preserves a suspect with a null registration token', token: null, dropped: false },
    { name: 'preserves a suspect with an empty registration token', token: '', dropped: false },
    { name: 'preserves a suspect with a non-string registration token', token: 42, dropped: false },
  ])('$name', async ({ token, dropped }) => {
    const root = mktemp('we-dispatch-cas-');
    const env = {
      WE_DAEMON_STATE_DIR: join(root, 'state'),
      WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'),
      WE_REBUILD_SMOKE_REUSE_ENABLED: '0',
    };
    const registration = { ref: 'lane/dispatch-cas', pr: 77, addedBy: 't' };
    addOverlay(root, registration, { env });
    const original = readOverlayState(root, { env }).overlays[0];
    const applied = { ...original, sha: 'a'.repeat(40) };
    if (token === 'missing') delete applied.registrationId;
    else if (token !== 'matching' && token !== 'replaced') applied.registrationId = token;
    const file = overlayFilePath(root, env);
    const eventBytes = () => readdirSync(env.WE_DAEMON_OVERLAY_DIR).filter(n => n.endsWith('.events.jsonl'))
      .sort().map(n => readFileSync(join(env.WE_DAEMON_OVERLAY_DIR, n), 'utf8')).join('');
    let listBeforeDrop;
    let eventsBeforeDrop;
    const dispatch = vi.fn(async () => {
      if (token === 'replaced') {
        removeOverlay(root, original.ref, { env, expectRegistrationId: original.registrationId });
        addOverlay(root, registration, { env });
        expect(readOverlayState(root, { env }).overlays[0].registrationId).not.toBe(original.registrationId);
      }
      // Capture after the operator's re-registration, before the dispatch result reaches the drop loop.
      listBeforeDrop = readFileSync(file, 'utf8');
      eventsBeforeDrop = eventBytes();
      return { ok: false, reason: 'commands-denied' };
    });
    const run = vi.fn((args) => {
      if (args[0] === 'merge-base') return { status: 0, stdout: 'b'.repeat(40) };
      if (args[0] === 'diff') return { status: 0, stdout: `${SETTINGS.dispatchPaths[0]}\n` };
      if (args[0] === 'worktree') return { status: 0, stdout: '' };
      // No cached smoke identity: the candidate must run both smoke stages.
      if (args[0] === 'rev-parse') return { status: 1, stdout: '' };
      throw new Error(`unexpected Git call: ${args.join(' ')}`);
    });
    const runSmoke = vi.fn(async () => PASS);
    const result = await smokeAndAdopt({
      root, env, stEnv: env, log: { error() {} }, run, runSmoke, now: Date.now,
      plan: { finalSha: applied.sha, mainSha: 'b'.repeat(40), inputsKey: 'dispatch-cas', applied: [applied] },
      prevHead: 'c'.repeat(40), lease: { token: 'lease', path: join(root, 'candidate') },
      overlaysBefore: [original], prepAlerts: [], mainOnly: false,
      finalLockOpts: { ...LOCK_OPTS, lockRoot: join(root, 'locks') },
      dispatchSmoke: { settings: SETTINGS, run: dispatch, match: (files, patterns) => files.filter(f => patterns.includes(f)) },
    });
    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].tree).toBe(join(root, 'candidate'));
    expect(result).toMatchObject({ moved: false, reason: 'dispatch-smoke-failed' });
    expect(readRebuildState(root, env).held.reason).toBe('dispatch-smoke-failed');
    const kinds = result.alerts.map(a => a.kind);
    expect(kinds).toContain('dispatch-smoke-failed');
    expect(kinds).not.toContain('overlay-drop-failed');
    if (dropped) {
      expect(readOverlayState(root, { env }).overlays).toEqual([]);
      const newEvents = eventBytes().slice(eventsBeforeDrop.length).trim().split('\n').map(line => JSON.parse(line));
      expect(newEvents.filter(e => e.kind === 'dropped-dispatch-smoke-failed')).toEqual([
        expect.objectContaining({ ref: original.ref, pr: original.pr }),
      ]);
      expect(kinds).toContain('overlay-dropped-dispatch-smoke-failed');
      expect(kinds).not.toContain('overlay-registration-changed');
    } else {
      expect(readFileSync(file, 'utf8')).toBe(listBeforeDrop);
      expect(eventBytes()).toBe(eventsBeforeDrop);
      expect(result.alerts).toContainEqual({ kind: 'overlay-registration-changed', detail: { ref: original.ref } });
      expect(kinds).not.toContain('overlay-dropped-dispatch-smoke-failed');
    }
  });
});

describe('dispatchSmokeSuspects', () => {
  const match = (files, pats) => files.filter((x) => pats.includes(x));
  const okGit = (files) => (args) => (args[0] === 'merge-base' ? { status: 0, stdout: 'base\n' } : { status: 0, stdout: files.join('\n') });
  it('skips an overlay already adopted at the same sha, and fails closed on an unreadable diff', () => {
    const applied = [{ ref: 'a', sha: '1' }, { ref: 'b', sha: '2' }];
    expect(dispatchSmokeSuspects({
      git: okGit(['p']), applied, adoptedApplied: [{ ref: 'a', sha: '1' }], patterns: ['p'], match,
    }).map((s) => s.ref)).toEqual(['b']);
    expect(dispatchSmokeSuspects({
      git: () => ({ status: 1 }), applied, adoptedApplied: null, patterns: ['p'], match,
    }).map((s) => s.reason)).toEqual(['diff-unknown', 'diff-unknown']);
    expect(dispatchSmokeSuspects({
      git: okGit(['q']), applied, adoptedApplied: null, patterns: ['p'], match,
    })).toEqual([]);
  });

  it('carries each applied row\'s registrationId, so the definite drop is bound to the smoked registration', () => {
    const applied = [{ ref: 'a', sha: '1', registrationId: 'reg-a' }, { ref: 'b', sha: '2' }];
    const out = dispatchSmokeSuspects({ git: okGit(['p']), applied, adoptedApplied: null, patterns: ['p'], match });
    expect(out.map((s) => [s.ref, s.registrationId])).toEqual([['a', 'reg-a'], ['b', undefined]]);
  });
});
