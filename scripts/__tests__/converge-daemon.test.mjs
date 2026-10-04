/**
 * @file converge-daemon.test.mjs — proof of the converge daemon's SCHEDULING SUBSTRATE (#2572, ruling R7):
 * `we:scripts/converge-daemon-pass.mjs` (the payload) and `we:scripts/converge-daemon-install.mjs` (the launchd
 * schedule). Both files are IO shells over pure resolvers, and it is the pure half that carries the risk, so
 * that is what this pins:
 *   • the PRIMARY-checkout refusal — a pass runs `git reset --hard`, so pointing the daemon at the operator's
 *     tree would clobber real uncommitted work (#2501 Fork A(a)'s forced invariant). Refused in BOTH the pass
 *     (`assertNotPrimary`) and the installer (`installBlockers`), because either one alone leaves a hole.
 *   • the IN-USE clone refusal — `assertNotPrimary` only knows about ONE tree, but `reset --hard` + `clean -fdq`
 *     destroys uncommitted work in ANY tree, and a pooled lane clone is exactly as destroyable as primary. A live
 *     lane lease, a dirty tree, or unpushed commits must all fail CLOSED, in the pass AND at install.
 *   • the LEDGER wire — the daemon's own clone has an empty gitignored `.conveyor/jury`, so a pass that did not
 *     repoint `CONVEYOR_JURY_DIR` would fold every PR fail-closed to keep-parked and record a soak that looks
 *     healthy and means nothing. The default must land on the PRIMARY tree's ledger, and the plist must carry it.
 *   • the runner ARGV — the wrapper must never construct a flag that could act. `--enforce` is refused by the
 *     runner itself, but the wrapper must not reach for it either (defence in depth, both halves tested).
 *   • plist rendering — a pure string build, so the escaping and the interval land where launchd reads them.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import {
  resolvePassConfig, buildRefreshSteps, buildRunnerArgv, buildPassRecord, assertNotPrimary,
  assertCloneNotInUse, PROVISION_CMD,
} from '../converge-daemon-pass.mjs';
import {
  LABEL, DEFAULT_INTERVAL_SEC, plistPath, resolveInstallConfig, renderPlist, installBlockers,
  systemdInstallSteps, systemdMain,
} from '../converge-daemon-install.mjs';

const HOME = '/home/op';
/** A config where every path is explicit — no reliance on the ambient machine. */
const ENV = {
  CONVERGE_DAEMON_CLONE: '/clones/we-converge-daemon/lane-1',
  CONVERGE_DAEMON_PRIMARY: '/work/webeverything',
  CONVERGE_DAEMON_STATE_ROOT: '/state/converge',
};

describe('resolvePassConfig', () => {
  it('defaults every path off $HOME when nothing is set', () => {
    const cfg = resolvePassConfig({}, HOME);
    expect(cfg.clone).toBe(join(HOME, 'workspace', '.lanes', 'we-converge-daemon', 'lane-1'));
    expect(cfg.primary).toBe(join(HOME, 'workspace', 'webeverything'));
    expect(cfg.stateRoot).toBe(join(HOME, '.converge-daemon'));
    expect(cfg.logPath).toBe(join(HOME, '.converge-daemon', 'shadow.jsonl'));
  });

  it('defaults the jury dir to the PRIMARY tree, not the clone — the clone\'s copy is always empty', () => {
    const cfg = resolvePassConfig(ENV, HOME);
    expect(cfg.juryDir).toBe('/work/webeverything/.conveyor/jury');
    expect(cfg.juryDir.startsWith(cfg.clone)).toBe(false);
  });

  it('lets the ledger be repointed — the one wire that changes when it becomes a shared store', () => {
    const cfg = resolvePassConfig({ ...ENV, CONVERGE_DAEMON_JURY_DIR: '/mnt/shared/jury' }, HOME);
    expect(cfg.juryDir).toBe('/mnt/shared/jury');
  });

  it('keeps the state root OUTSIDE the clone, so `git clean -fdq` cannot eat the soak record', () => {
    const cfg = resolvePassConfig(ENV, HOME);
    expect(cfg.logPath.startsWith(cfg.clone)).toBe(false);
  });

  it('treats a blank env var as unset rather than resolving it to CWD', () => {
    const cfg = resolvePassConfig({ ...ENV, CONVERGE_DAEMON_REPO: '   ' }, HOME);
    expect(cfg.repo).toBeNull();
  });
});

describe('assertNotPrimary', () => {
  it('refuses when the clone IS the primary checkout', () => {
    const msg = assertNotPrimary({ clone: '/work/webeverything', primary: '/work/webeverything' });
    expect(msg).toMatch(/refusing to run from the PRIMARY checkout/);
  });

  it('refuses through a non-normalised path, not just an identical string', () => {
    const msg = assertNotPrimary({ clone: '/work/webeverything/../webeverything', primary: '/work/webeverything' });
    expect(msg).toMatch(/refusing/);
  });

  it('passes a genuinely separate clone', () => {
    expect(assertNotPrimary({ clone: '/clones/lane-1', primary: '/work/webeverything' })).toBeNull();
  });

  it('refuses through a SYMLINK, not just a lexical match — a link to primary is still primary', () => {
    // `~/we -> ~/work/webeverything`: lexically these are two different paths, and `resolve` alone would let the
    // daemon `reset --hard` the operator's tree through the link.
    const realpathOf = (p) => (p === '/home/op/we' ? '/work/webeverything' : p);
    const msg = assertNotPrimary({ clone: '/home/op/we', primary: '/work/webeverything' }, realpathOf);
    expect(msg).toMatch(/refusing to run from the PRIMARY checkout/);
  });

  it('names the provisioning command that actually works — `--name=`, not the read-only `--pool=` selector', () => {
    // lane-pool.mjs documents `--pool` as an EXISTING-pool selector for read/release ops and its own `cloneLane`
    // refuses a clone path with it. Pointing the operator at `--pool` for provisioning is an unusable instruction.
    expect(PROVISION_CMD).toContain('--name=we-converge-daemon');
    expect(PROVISION_CMD).not.toContain('--pool=');
    const msg = assertNotPrimary({ clone: '/work/webeverything', primary: '/work/webeverything' });
    expect(msg).toContain(PROVISION_CMD);
  });
});

describe('assertCloneNotInUse', () => {
  const CLEAN = { dirty: false, ahead: false, lease: null };
  const now = Date.parse('2026-08-08T12:00:00Z');
  const lease = (mins) => ({
    session: 'Mac:1234', purpose: 'review-1113', ttlMinutes: 240,
    acquiredAt: new Date(now - mins * 60_000).toISOString(),
  });

  it('passes a clean, unleased, up-to-date clone — the daemon\'s own clone at rest', () => {
    expect(assertCloneNotInUse('/clones/lane-1', CLEAN, now)).toBeNull();
  });

  it('refuses a clone holding a LIVE lane lease — the collision assertNotPrimary cannot see', () => {
    const msg = assertCloneNotInUse('/lanes/web-everything/lane-3', { ...CLEAN, lease: lease(5) }, now);
    expect(msg).toMatch(/LIVE lane lease/);
    expect(msg).toContain('review-1113'); // says WHO, so the operator can find the session
    expect(msg).toMatch(/clean -fdq/);    // and says what would have been destroyed
  });

  it('ignores a STALE lease — a crashed session must not wedge the daemon forever', () => {
    // 240-minute TTL; a lease acquired 10 hours ago is long dead.
    expect(assertCloneNotInUse('/clones/lane-1', { ...CLEAN, lease: lease(600) }, now)).toBeNull();
  });

  it('refuses a DIRTY tree — uncommitted or untracked work `clean -fdq` would eat', () => {
    expect(assertCloneNotInUse('/clones/lane-1', { ...CLEAN, dirty: true }, now)).toMatch(/uncommitted or untracked/);
  });

  it('refuses a clone AHEAD of its upstream — unpushed commits live nowhere else (#2267)', () => {
    expect(assertCloneNotInUse('/clones/lane-1', { ...CLEAN, ahead: true }, now)).toMatch(/not pushed/);
  });

  it('treats a missing state object as safe-to-refuse-nothing rather than throwing', () => {
    expect(assertCloneNotInUse('/clones/lane-1', null, now)).toBeNull();
  });
});

describe('buildRefreshSteps', () => {
  it('fetches, hard-resets to origin/main and cleans — all scoped to the clone via -C', () => {
    const steps = buildRefreshSteps('/clones/lane-1');
    expect(steps.map((s) => s.join(' '))).toEqual([
      'git -C /clones/lane-1 fetch --quiet origin main',
      'git -C /clones/lane-1 reset --hard --quiet origin/main',
      'git -C /clones/lane-1 clean -fdq',
    ]);
    for (const step of steps) expect(step.slice(0, 3)).toEqual(['git', '-C', '/clones/lane-1']);
  });
});

describe('buildRunnerArgv', () => {
  it('runs the shadow runner in JSON mode', () => {
    expect(buildRunnerArgv({ repo: null })).toEqual(['scripts/review-runner.mjs', '--json']);
  });

  it('passes an explicit repo through', () => {
    expect(buildRunnerArgv({ repo: 'frontier-ui/frontierui' })).toContain('--repo=frontier-ui/frontierui');
  });

  it('never constructs a flag that could ACT — no --enforce anywhere in the argv', () => {
    for (const repo of [null, 'web-everything/web-everything']) {
      expect(buildRunnerArgv({ repo }).join(' ')).not.toMatch(/enforce/);
    }
  });
});

describe('buildPassRecord', () => {
  const cfg = { clone: '/clones/lane-1', juryDir: '/work/webeverything/.conveyor/jury' };

  it('folds a real pass into the soak record', () => {
    const rec = buildPassRecord({
      startedAt: '2026-08-08T18:00:00.000Z',
      cfg,
      exitCode: 0,
      summary: {
        ranPass: true, discovered: 4, clearable: 3, wouldClear: 1, wouldKeepParked: 2, mutations: 0,
        records: [
          {
            subject: 'we#42', pr: 42, repo: 'we', wouldClear: false, reason: 'self-clear-refused: …',
            panelVerdict: 'accept', outstandingFindings: 0, // extra fields buildShadowRecord emits — must be TRIMMED, not passed through
          },
        ],
      },
      error: null,
    });
    expect(rec).toMatchObject({ ranPass: true, discovered: 4, wouldClear: 1, wouldKeepParked: 2, mutations: 0 });
    expect(rec.error).toBeNull();
    // #3008 Problem 1 — the per-PR detail (which PR, and why) must survive into the persisted record, not just
    // the pass-level aggregate counts.
    expect(rec.records).toHaveLength(1);
    expect(rec.records[0]).toEqual({
      subject: 'we#42', pr: 42, repo: 'we', wouldClear: false, reason: 'self-clear-refused: …',
    });
  });

  it('RECORDS a pass that could not run — a gap the readiness predicate cannot see is one it cannot account for', () => {
    const rec = buildPassRecord({
      startedAt: '2026-08-08T18:15:00.000Z',
      cfg,
      exitCode: 0,
      summary: { ranPass: false, reason: 'lease-held', records: [] },
      error: null,
    });
    expect(rec.ranPass).toBe(false);
    expect(rec.reason).toBe('lease-held');
    // The lease-held fixture's own `records: []` must survive to the output, not just `ranPass`/`reason` (#3008).
    expect(rec.records).toEqual([]);
  });

  it('carries a hard failure rather than dropping it', () => {
    const rec = buildPassRecord({ startedAt: 'x', cfg, exitCode: 2, summary: null, error: 'gh exploded' });
    expect(rec.error).toBe('gh exploded');
    expect(rec.ranPass).toBe(false);
    // `summary` is null (no parseable JSON) — `records` defaults to `[]`, never `undefined`/`null` (#3008).
    expect(rec.records).toEqual([]);
  });

  it('defaults records to [] for a refuse()-shaped summary with no records key at all', () => {
    // The daemon's own pre-flight `refuse()` path never calls review-runner, so its `summary` carries no
    // `records` key (unlike the lease-held fixture above, which review-runner itself emits WITH `records: []`).
    const rec = buildPassRecord({
      startedAt: 'x', cfg, exitCode: 2,
      summary: { ranPass: false, reason: 'refused' },
      error: 'converge-daemon: refusing to run from the PRIMARY checkout',
    });
    expect(rec.ranPass).toBe(false);
    expect(rec.records).toEqual([]);
  });

  it('records which ledger the pass actually read — the soak is uninterpretable without it', () => {
    const rec = buildPassRecord({ startedAt: 'x', cfg, exitCode: 0, summary: { ranPass: true }, error: null });
    expect(rec.juryDir).toBe('/work/webeverything/.conveyor/jury');
  });
});

describe('resolveInstallConfig', () => {
  it('points the launchd job at the script INSIDE the daemon clone, so a self-update needs no reinstall', () => {
    const cfg = resolveInstallConfig(ENV, HOME, '/usr/bin/node');
    expect(cfg.script).toBe('/clones/we-converge-daemon/lane-1/scripts/converge-daemon-pass.mjs');
    expect(cfg.script.startsWith(cfg.primary)).toBe(false);
  });

  it('defaults to a 15-minute interval and honours a valid override', () => {
    expect(resolveInstallConfig(ENV, HOME, '/usr/bin/node').intervalSec).toBe(DEFAULT_INTERVAL_SEC);
    expect(resolveInstallConfig({ ...ENV, CONVERGE_DAEMON_INTERVAL_SEC: '60' }, HOME, '/usr/bin/node').intervalSec).toBe(60);
  });

  it('falls back rather than rendering a garbage or zero interval into the plist', () => {
    for (const bad of ['0', '-5', 'soon', '']) {
      const cfg = resolveInstallConfig({ ...ENV, CONVERGE_DAEMON_INTERVAL_SEC: bad }, HOME, '/usr/bin/node');
      expect(cfg.intervalSec).toBe(DEFAULT_INTERVAL_SEC);
    }
  });
});

describe('renderPlist', () => {
  const cfg = resolveInstallConfig(ENV, HOME, '/opt/node/bin/node');

  it('renders a periodic StartInterval job, NOT a resident KeepAlive one', () => {
    const xml = renderPlist(cfg);
    expect(xml).toContain(`<key>StartInterval</key><integer>${DEFAULT_INTERVAL_SEC}</integer>`);
    expect(xml).not.toContain('KeepAlive');
  });

  it('carries the ledger wire — without it the daemon reads its clone\'s empty ledger and the soak is a lie', () => {
    expect(renderPlist(cfg)).toContain('<key>CONVERGE_DAEMON_JURY_DIR</key><string>/work/webeverything/.conveyor/jury</string>');
  });

  it('runs the pass from the clone, with the clone as the working directory', () => {
    const xml = renderPlist(cfg);
    expect(xml).toContain('<string>/opt/node/bin/node</string>');
    expect(xml).toContain('<string>/clones/we-converge-daemon/lane-1/scripts/converge-daemon-pass.mjs</string>');
    expect(xml).toContain('<key>WorkingDirectory</key><string>/clones/we-converge-daemon/lane-1</string>');
  });

  it('XML-escapes path values rather than emitting a corrupt plist', () => {
    const xml = renderPlist({ ...cfg, clone: '/clones/a&b<c>' });
    expect(xml).toContain('/clones/a&amp;b&lt;c&gt;');
    expect(xml).not.toContain('/clones/a&b<c>');
  });

  it('omits the repo override entirely when none is configured', () => {
    expect(renderPlist(cfg)).not.toContain('CONVERGE_DAEMON_REPO');
    expect(renderPlist({ ...cfg, repo: 'frontier-ui/frontierui' })).toContain('<key>CONVERGE_DAEMON_REPO</key><string>frontier-ui/frontierui</string>');
  });
});

describe('installBlockers', () => {
  const all = () => true;
  /** The in-use probe, injected so the blocker set is decided with no git and no fs. */
  const idle = () => ({ dirty: false, ahead: false, lease: null });
  const cfg = resolveInstallConfig(ENV, HOME, '/usr/bin/node');

  it('is empty when the clone, the script and the ledger all exist', () => {
    expect(installBlockers(cfg, all, idle)).toEqual([]);
  });

  it('blocks an install pointed at the primary checkout', () => {
    const blockers = installBlockers({ ...cfg, clone: cfg.primary, script: `${cfg.primary}/scripts/converge-daemon-pass.mjs` }, all, idle);
    expect(blockers.join('\n')).toMatch(/PRIMARY checkout/);
  });

  it('blocks a missing clone and names the provision command', () => {
    const blockers = installBlockers(cfg, (p) => p !== cfg.clone, idle);
    expect(blockers.join('\n')).toContain(PROVISION_CMD);
    expect(blockers.join('\n')).toMatch(/lane-pool\.mjs provision .*--name=we-converge-daemon/);
  });

  it('blocks a clone that predates this change rather than scheduling a job that cannot run', () => {
    const blockers = installBlockers(cfg, (p) => p !== cfg.script, idle);
    expect(blockers.join('\n')).toMatch(/no scripts\/converge-daemon-pass\.mjs/);
  });

  it('blocks a missing ledger dir — an absent ledger looks like a working daemon and is not', () => {
    const blockers = installBlockers(cfg, (p) => p !== cfg.juryDir, idle);
    expect(blockers.join('\n')).toMatch(/jury ledger dir/);
  });

  it('blocks an install pointed at a LEASED lane clone — refuse while a human is here to read it', () => {
    const leased = () => ({ dirty: false, ahead: false, lease: { session: 'Mac:99', purpose: 'batch', ttlMinutes: 240, acquiredAt: new Date().toISOString() } });
    const blockers = installBlockers(cfg, all, leased);
    expect(blockers.join('\n')).toMatch(/LIVE lane lease/);
    // Reworded for the installer's "refusing to install —" preamble, not left as a pass-time sentence.
    expect(blockers.join('\n')).not.toMatch(/refusing to run from/);
  });

  it('blocks an install pointed at a DIRTY clone', () => {
    const dirty = () => ({ dirty: true, ahead: false, lease: null });
    expect(installBlockers(cfg, all, dirty).join('\n')).toMatch(/uncommitted or untracked/);
  });
});

describe('plistPath', () => {
  it('lands in the per-user LaunchAgents dir under the WE-owned label', () => {
    expect(plistPath(LABEL, HOME)).toBe(join(HOME, 'Library', 'LaunchAgents', 'com.webeverything.converge-daemon.plist'));
  });
});

/**
 * #3197 — the systemd ORCHESTRATION, not its step list.
 *
 * `systemdInstallSteps` is separate and exported precisely because the ORDER is the correctness property: the
 * #1465 juror found that `enable --now` is a no-op on a timer that is already active, so a re-install carrying
 * a changed interval or clone wrote new unit files and left the RUNNING timer on the old ones — silently
 * diverging from the config the operator believes is installed. The launchd path never had this bug because it
 * `bootout`s first; this path claimed to mirror it and did not.
 *
 * A test of the pure step list cannot see whether the caller RUNS them in that order, or whether only the one
 * marked `decides` reaches the exit code. That is what these pin. Every handle is injected — no `systemctl` is
 * spawned, no unit file is written, so this runs on a mac as readily as on the Linux host it describes.
 */
describe('systemdMain() — the install orchestration (#3197)', () => {
  const cfg = resolveInstallConfig(ENV, HOME, '/usr/bin/node');
  const OK = { status: 0, stdout: '', stderr: '' };

  const spyIo = (over = {}) => {
    const io = {
      calls: [], written: [], removed: [], made: [], out: [], errs: [],
      systemctl: (...args) => { io.calls.push(args); return OK; },
      exists: () => true,
      // A CLEAN clone, injected — `installBlockers` would otherwise shell git at the fixture path, which is
      // both a real process and a different answer on every machine.
      probe: () => ({ dirty: false, ahead: false, lease: null }),
      mkdir: (d) => io.made.push(d),
      writeFile: (path, content) => io.written.push({ path, content }),
      rm: (path) => io.removed.push(path),
      ...over,
    };
    io.out = []; io.errs = [];
    io.outWrites = io.out;
    return { ...io, out: (t) => io.outWrites.push(t), errOut: (t) => io.errs.push(t), _: io };
  };

  // THE REGRESSION. Not "three calls happened" — the SEQUENCE, matched against the declared step list so the
  // two cannot drift apart. `stop` before `enable --now` is the whole fix.
  it('runs reload → stop → enable --now, in the order systemdInstallSteps declares', () => {
    const io = spyIo();
    expect(systemdMain('install', cfg, ['--force'], io)).toBe(0);
    const timerUnit = io._.calls.at(-1).at(-1);
    expect(io._.calls).toEqual(systemdInstallSteps(timerUnit).map((s) => s.args));
    expect(io._.calls.map((c) => c[0])).toEqual(['daemon-reload', 'stop', 'enable']);
  });

  it('writes both unit files BEFORE it touches systemctl', () => {
    const order = [];
    const io = spyIo({
      writeFile: (path) => order.push(`write:${path.split('/').at(-1)}`),
      systemctl: (...args) => { order.push(`systemctl:${args[0]}`); return OK; },
    });
    systemdMain('install', cfg, ['--force'], io);
    expect(order.filter((o) => o.startsWith('write:'))).toHaveLength(2);
    expect(order.findIndex((o) => o.startsWith('systemctl:'))).toBe(2);
  });

  /**
   * `daemon-reload` and `stop` are deliberately unchecked: on a FIRST install there is nothing to stop, and
   * reporting that benign no-op as a failed install would make the installer fail on exactly the machine it
   * was written for. This pins that BEHAVIOUR.
   *
   * It does NOT pin the `if (s.decides)` guard, and saying so is the point. `decides` currently marks the LAST
   * step, so `on = r` unconditionally would leave the same value in `on` — the guard is unobservable from
   * outside and removing it reddens nothing here. It is defence for the step list this code does not yet have
   * (anything appended after `enable --now`), in the same spirit as the depth guard in `needsAcceptanceRestamp`.
   * A test claiming to cover it would be claiming coverage it does not have.
   */
  it('does not let an unchecked step fail the install, and does let the decisive one', () => {
    const failEarly = spyIo({ systemctl: (...args) => { failEarly._.calls.push(args); return args[0] === 'enable' ? OK : { status: 5, stderr: 'not loaded' }; } });
    expect(systemdMain('install', cfg, ['--force'], failEarly)).toBe(0);

    const failEnable = spyIo({ systemctl: (...args) => { failEnable._.calls.push(args); return args[0] === 'enable' ? { status: 1, stderr: 'no user manager' } : OK; } });
    expect(systemdMain('install', cfg, ['--force'], failEnable)).toBe(1);
    expect(failEnable._.errs.join('')).toMatch(/loginctl enable-linger/);
  });

  // A refusal must be a refusal: nothing written, nothing enabled. `--force` is the only way past it, and the
  // test above relies on that, so this pins the gate it steps over.
  it('refuses to install over a blocker, writing nothing and calling nothing', () => {
    const io = spyIo({ exists: () => false });   // no clone at the configured path
    expect(systemdMain('install', cfg, [], io)).toBe(2);
    expect(io._.calls).toEqual([]);
    expect(io._.written).toEqual([]);
    expect(io._.errs.join('')).toMatch(/refusing to install/);
  });

  // Uninstall removes the unit FILES whatever `disable` did — otherwise the next daemon-reload brings the
  // timer back — and a `disable` that failed only because nothing was loaded is not a failure.
  it('removes the unit files even when disable reports the timer was never loaded', () => {
    const io = spyIo({ systemctl: (...args) => { io._.calls.push(args); return args[0] === 'disable' ? { status: 1, stderr: 'Unit not loaded.' } : OK; } });
    expect(systemdMain('uninstall', cfg, [], io)).toBe(0);
    expect(io._.removed).toHaveLength(2);
    expect(io._.calls.map((c) => c[0])).toEqual(['disable', 'daemon-reload']);
  });

  it('reports a disable that genuinely failed, after removing the files anyway', () => {
    const io = spyIo({ systemctl: (...args) => { io._.calls.push(args); return args[0] === 'disable' ? { status: 1, stderr: 'Access denied' } : OK; } });
    expect(systemdMain('uninstall', cfg, [], io)).toBe(1);
    expect(io._.removed).toHaveLength(2);
    expect(io._.errs.join('')).toMatch(/may still be running/);
  });

  it('print and status touch nothing', () => {
    const io = spyIo();
    expect(systemdMain('print', cfg, [], io)).toBe(0);
    expect(io._.calls).toEqual([]);
    expect(io._.written).toEqual([]);

    const st = spyIo({ systemctl: (...args) => { st._.calls.push(args); return { status: 0, stdout: 'enabled\n', stderr: '' }; } });
    expect(systemdMain('status', cfg, [], st)).toBe(0);
    expect(st._.calls.map((c) => c[0])).toEqual(['is-enabled', 'is-active']);
    expect(st._.written).toEqual([]);
    expect(JSON.parse(st._.outWrites.join(''))).toMatchObject({ scheduler: 'systemd', timerEnabled: 'enabled' });
  });

  it('rejects an unknown command with the usage text and exit 2', () => {
    const io = spyIo();
    expect(systemdMain('frobnicate', cfg, [], io)).toBe(2);
    expect(io._.errs.join('')).toMatch(/usage: converge-daemon-install\.mjs/);
  });
});
