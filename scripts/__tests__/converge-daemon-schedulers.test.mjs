/**
 * @file converge-daemon-schedulers.test.mjs — the scheduler half renders the same config for either host init,
 *   and refuses honestly where neither applies. Pure over injected cfg / platform / probes; no io.
 */
import { describe, it, expect } from 'vitest';
import { renderSystemdUnits, sdQuote, systemdUnitNames, detectScheduler } from '../lib/converge-daemon-schedulers.mjs';
import { systemdInstallSteps } from '../converge-daemon-install.mjs';

const cfg = {
  label: 'com.webeverything.converge-daemon',
  node: '/usr/bin/node',
  script: '/srv/we-daemon/scripts/converge-daemon-pass.mjs',
  clone: '/srv/we-daemon',
  primary: '/home/n/workspace/webeverything',
  stateRoot: '/home/n/.we-converge',
  juryDir: '/home/n/workspace/webeverything/.conveyor/jury',
  stdoutPath: '/home/n/.we-converge/daemon.log',
  intervalSec: 900,
  repo: 'web-everything/web-everything',
};

describe('systemdUnitNames', () => {
  it('derives both unit names from the one label', () => {
    expect(systemdUnitNames(cfg.label)).toEqual({
      service: 'com.webeverything.converge-daemon.service',
      timer: 'com.webeverything.converge-daemon.timer',
    });
  });
});

describe('renderSystemdUnits', () => {
  it('runs the pass from the daemon clone, never the primary checkout', () => {
    const { service } = renderSystemdUnits(cfg);
    // Quoted — see the space-in-path suite below. This assertion originally pinned the UNQUOTED form, which
    // is part of how the word-splitting bug survived: the test encoded the defect as the contract.
    expect(service).toContain(`WorkingDirectory="${cfg.clone}"`);
    expect(service).toContain(`ExecStart="${cfg.node}" "${cfg.script}"`);
    expect(service).not.toContain(cfg.primary.concat('\n'));
  });

  // Without this the daemon folds against its own clone's empty ledger and records keep-parked for every PR —
  // a soak that looks like it worked and means nothing. Same wire the plist carries.
  it('carries the jury ledger wire', () => {
    expect(renderSystemdUnits(cfg).service).toContain(`Environment="CONVERGE_DAEMON_JURY_DIR=${cfg.juryDir}"`);
  });

  it('omits the repo variable when the config has no repo', () => {
    const { service } = renderSystemdUnits({ ...cfg, repo: null });
    expect(service).not.toContain('CONVERGE_DAEMON_REPO');
  });

  // systemd splits an unquoted Environment= value on whitespace, so a path with a space would silently
  // truncate — and a truncated clone path is a daemon that resets the wrong directory.
  it('quotes and escapes environment values so a path with a space survives', () => {
    const { service } = renderSystemdUnits({ ...cfg, clone: '/srv/we daemon' });
    expect(service).toContain('Environment="CONVERGE_DAEMON_CLONE=/srv/we daemon"');
  });

  it('escapes a quote inside a path rather than ending the value early', () => {
    const { service } = renderSystemdUnits({ ...cfg, stateRoot: '/home/n/we"state' });
    expect(service).toContain('Environment="CONVERGE_DAEMON_STATE_ROOT=/home/n/we\\"state"');
  });

  // Measured from the END of the last run, so a pass slower than the interval cannot stack on itself.
  it('paces from the previous run rather than the wall clock', () => {
    const { timer } = renderSystemdUnits(cfg);
    expect(timer).toContain(`OnUnitInactiveSec=${cfg.intervalSec}s`);
    expect(timer).not.toContain('OnCalendar');
  });

  it('fires the service the label names, and installs into timers.target', () => {
    const { timer } = renderSystemdUnits(cfg);
    expect(timer).toContain(`Unit=${cfg.label}.service`);
    expect(timer).toContain('WantedBy=timers.target');
  });

  // A oneshot mirrors launchd's StartInterval; a Restart=always service would buy resident supervision the
  // shadow era has no use for.
  it('is a oneshot, not a resident service', () => {
    expect(renderSystemdUnits(cfg).service).toContain('Type=oneshot');
  });
});

describe('detectScheduler', () => {
  it('keeps macOS on launchd', () => {
    expect(detectScheduler('darwin')).toEqual({ scheduler: 'launchd', reason: null });
  });

  it('uses systemd on a Linux host that has it', () => {
    expect(detectScheduler('linux', (p) => p === '/run/systemd/system').scheduler).toBe('systemd');
  });

  // An init-less container should get a refusal naming what it found — not a unit file nothing will read.
  it('refuses on Linux without systemd, and names the fallback', () => {
    const { scheduler, reason } = detectScheduler('linux', () => false);
    expect(scheduler).toBeNull();
    expect(reason).toMatch(/cron|supervisor/);
  });

  it('refuses an unsupported platform by name', () => {
    expect(detectScheduler('win32', () => true).reason).toMatch(/win32/);
  });
});

/**
 * A path with a space must survive EVERY directive, not just `Environment=`.
 *
 * The first cut quoted only `Environment=` while its own comment said "quote every value", leaving
 * `ExecStart=` and `WorkingDirectory=` bare. systemd word-splits an unquoted `ExecStart=`, so a clone path
 * containing a space installed a unit whose ExecStart never ran the intended script — a daemon that reports
 * installed and silently does nothing, which is the worst available failure mode.
 */
describe('systemd units survive a path with a space', () => {
  const cfg = {
    label: 'com.we.converge', clone: '/srv/we daemon', primary: '/srv/we primary',
    node: '/usr/local/my node/bin/node', script: '/srv/we daemon/scripts/converge-daemon-pass.mjs',
    stateRoot: '/srv/we state', juryDir: '/srv/we jury', intervalSec: 900,
    stdoutPath: '/srv/we daemon/out.log', logPath: '/srv/we daemon/shadow.log',
  };

  it('quotes ExecStart so systemd does not word-split the command', () => {
    const { service } = renderSystemdUnits(cfg);
    const line = service.split('\n').find((l) => l.startsWith('ExecStart='));
    expect(line).toBe('ExecStart="/usr/local/my node/bin/node" "/srv/we daemon/scripts/converge-daemon-pass.mjs"');
  });

  it('quotes WorkingDirectory', () => {
    const { service } = renderSystemdUnits(cfg);
    expect(service).toContain('WorkingDirectory="/srv/we daemon"');
  });

  it('still quotes every Environment value', () => {
    const { service } = renderSystemdUnits(cfg);
    expect(service).toContain('Environment="CONVERGE_DAEMON_CLONE=/srv/we daemon"');
    expect(service).toContain('Environment="CONVERGE_DAEMON_JURY_DIR=/srv/we jury"');
  });

  it('escapes an embedded quote and backslash rather than ending the string early', () => {
    expect(sdQuote('a"b')).toBe('a\\"b');
    expect(sdQuote('a\\b')).toBe('a\\\\b');
    const { service } = renderSystemdUnits({ ...cfg, clone: '/srv/we "odd"' });
    expect(service).toContain('WorkingDirectory="/srv/we \\"odd\\""');
  });

  it('leaves the append: log paths unwrapped — they are not argv and quotes would join the filename', () => {
    const { service } = renderSystemdUnits(cfg);
    expect(service).toContain('StandardOutput=append:/srv/we daemon/out.log');
    expect(service).not.toContain('StandardOutput=append:"');
  });
});

/**
 * The install sequence must STOP before it enables.
 *
 * `enable --now` is a no-op on an already-active timer, so a second `install` with a changed interval left
 * the running timer on the old config while reporting success. The launchd path never had this — it
 * `bootout`s first. The ORDER is the property, so the order is what is asserted.
 */
describe('the systemd install sequence', () => {
  const steps = systemdInstallSteps('com.we.converge.timer');
  const verbs = steps.map((s) => s.args[0]);

  it('stops the timer BEFORE enabling it, after reloading units', () => {
    expect(verbs).toEqual(['daemon-reload', 'stop', 'enable']);
    expect(verbs.indexOf('stop')).toBeLessThan(verbs.indexOf('enable'));
  });

  it('targets the timer unit it was given, and enables with --now', () => {
    expect(steps[1].args).toEqual(['stop', 'com.we.converge.timer']);
    expect(steps[2].args).toEqual(['enable', '--now', 'com.we.converge.timer']);
  });

  it('lets ONLY the enable decide the exit code — a benign first-install stop must not fail it', () => {
    expect(steps.filter((s) => s.decides).map((s) => s.args[0])).toEqual(['enable']);
  });
});
