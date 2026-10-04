/**
 * @file converge-daemon-schedulers.mjs — the SCHEDULER half of the converge daemon, one renderer per host init.
 *
 * WHY THIS FILE EXISTS. `converge-daemon-install.mjs` (#2572 R7) was written against launchd because the
 * operator's box is a Mac, and the ruling that pinned it there is about AUTH — the enforce-era pass spawns the
 * `claude` CLI on the operator's subscription (#2444). That reason binds the daemon to wherever the credential
 * lives; it never bound it to *launchd*. The pass itself (`converge-daemon-pass.mjs`) is portable Node, and the
 * install's config derivation and preflight refusals are already pure. So the Mac-only part was one XML
 * renderer and two `launchctl` calls — everything else is the same core.
 *
 * This module holds the per-init renderers so adding a host is one function and a table row, not a fork of the
 * installer. Every renderer is PURE over the same `cfg` that `resolveInstallConfig` already produces.
 *
 * WHAT A LINUX DAEMON DOES AND DOES NOT UNBLOCK — stated here because the obvious hope is wrong. It does NOT
 * make the daemon runnable inside an Anthropic-managed cloud VM. Two independent walls stand there, neither of
 * which is the scheduler:
 *   • `gh` is not installed, and both `review-runner.mjs` and `review-pr-io.mjs` shell it to read a PR.
 *   • `api.github.com` is refused by the environment's egress policy — 403 through the agent proxy even with
 *     the `GH_TOKEN` that is present in the container. The proxy README classes that as an organization policy
 *     denial to report rather than retry, so a REST fallback would not rescue it either.
 * What it DOES unblock is every other Linux host: a workstation, a home server, a long-lived VM, a CI runner,
 * or a self-hosted environment whose egress boundary you own — anywhere `gh` is installed and the subscription
 * credential lives. That is the population this renderer is for.
 */

/** The systemd unit names for a label. PURE. */
export function systemdUnitNames(label) {
  return { service: `${label}.service`, timer: `${label}.timer` };
}

/**
 * Render the systemd user units — a oneshot service plus the timer that fires it. PURE.
 *
 * A TIMER, NOT A `Restart=always` SERVICE, to mirror launchd's `StartInterval` exactly: the shadow pass is a
 * one-shot that exits and holds its own TTL singleton lease, so periodic firing IS the whole daemon. Buying
 * resident supervision now would pay for the enforce era before reaching it — the same call #2572 made.
 *
 * `OnUnitInactiveSec` rather than `OnCalendar` keeps the interval measured from the END of the previous run,
 * so a pass that takes longer than the interval cannot stack a second one on top of itself.
 *
 * @param {object} cfg - the same object `resolveInstallConfig` returns
 * @returns {{service: string, timer: string}}
 */
/**
 * Escape a value for the inside of a systemd double-quoted string. PURE.
 *
 * ONE helper, used by EVERY path-bearing directive, because the first cut quoted only `Environment=` — while
 * its own comment said "quote every value" — and left `ExecStart=` and `WorkingDirectory=` bare. systemd
 * word-splits an unquoted `ExecStart=`, so a clone path with a space installed a unit whose ExecStart never
 * ran the intended script: a silent no-op daemon that looks installed (review-pr correctness juror on #1465).
 *
 * `StandardOutput=append:PATH` is deliberately NOT wrapped: it is not an argv and systemd does not word-split
 * it, so quoting there would make the quotes part of the filename.
 */
export function sdQuote(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function renderSystemdUnits(cfg) {
  const env = [
    ['CONVERGE_DAEMON_CLONE', cfg.clone],
    ['CONVERGE_DAEMON_PRIMARY', cfg.primary],
    ['CONVERGE_DAEMON_STATE_ROOT', cfg.stateRoot],
    // Same wire as the plist: without it the daemon folds against its own clone's empty ledger and every PR
    // records keep-parked, which looks like a working soak and is not.
    ['CONVERGE_DAEMON_JURY_DIR', cfg.juryDir],
  ];
  if (cfg.repo) env.push(['CONVERGE_DAEMON_REPO', cfg.repo]);

  // systemd splits on whitespace unless the value is quoted, and these are paths a user may well put a space
  // in. Quote every value and escape the quote and backslash that would end it early.
  const envLines = env
    .map(([k, v]) => `Environment="${k}=${sdQuote(v)}"`)
    .join('\n');

  const service = `[Unit]
Description=Web Everything converge daemon (shadow pass)
Documentation=https://github.com/web-everything/web-everything/blob/main/scripts/converge-daemon-pass.mjs

[Service]
Type=oneshot
WorkingDirectory="${sdQuote(cfg.clone)}"
ExecStart="${sdQuote(cfg.node)}" "${sdQuote(cfg.script)}"
${envLines}
# The pass appends to its own shadow log; journald keeps stdout/stderr as well, so a failed fire is
# recoverable with \`journalctl --user -u ${cfg.label}.service\` even if the log write itself is what broke.
StandardOutput=append:${cfg.stdoutPath}
StandardError=append:${cfg.stdoutPath}
`;

  const timer = `[Unit]
Description=Fire the Web Everything converge shadow pass every ${cfg.intervalSec}s

[Timer]
# Mirrors launchd RunAtLoad: fire shortly after the user session starts, then on the interval.
OnStartupSec=1min
OnUnitInactiveSec=${cfg.intervalSec}s
AccuracySec=30s
Unit=${cfg.label}.service

[Install]
WantedBy=timers.target
`;

  return { service, timer };
}

/**
 * Which init system to target. PURE over an injected platform + probe, so both branches are testable from
 * either host.
 *
 * Deliberately NOT auto-detecting beyond platform: a Linux box without systemd (a container, an init-less
 * image) should get an honest refusal naming what it found, not a silently-written unit file that nothing
 * will ever read.
 *
 * @param {string} [platform] - `process.platform`
 * @param {(p: string) => boolean} [exists]
 * @returns {{scheduler: 'launchd'|'systemd'|null, reason: string|null}}
 */
export function detectScheduler(platform = process.platform, exists = () => false) {
  if (platform === 'darwin') return { scheduler: 'launchd', reason: null };
  if (platform !== 'linux') {
    return { scheduler: null, reason: `unsupported platform "${platform}" — the daemon schedules with launchd (macOS) or systemd (Linux).` };
  }
  if (!exists('/run/systemd/system')) {
    return {
      scheduler: null,
      reason: 'linux without systemd (no /run/systemd/system) — run `node scripts/converge-daemon-pass.mjs` '
        + 'from cron or any supervisor instead; the pass is a plain one-shot and needs no daemon wrapper.',
    };
  }
  return { scheduler: 'systemd', reason: null };
}
