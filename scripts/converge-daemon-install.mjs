#!/usr/bin/env node
/**
 * converge-daemon-install.mjs — the SCHEDULE half of the converge daemon substrate (#2572, ruling R7).
 *
 * WHERE THE DAEMON RUNS (the R7 ruling, operator 2026-08-08): a launchd job on the operator's Mac, sibling to
 * the already-resident drain daemon (`com.plateau.drain-daemon`), running from its OWN dedicated clone. The
 * binding reason is AUTH, not convenience: the enforce-era pass spawns the `claude` CLI on the operator's
 * SUBSCRIPTION, and #2444 ([#agent-runner-cli-backend]) settled that SDK-on-subscription is broken rather than
 * merely worse — so the daemon runs where that credential lives. The cost is honest and accepted: it only runs
 * while the Mac is awake.
 *
 * WHAT THIS IS NOT: a claim that local is the end state. The two things pinning it to this Mac are the
 * subscription credential (not fixable now) and the jury ledger living on a working tree's disk (fixable, and
 * filed separately). When the ledger becomes a shared store, `CONVERGE_DAEMON_JURY_DIR` is the only wire that
 * changes and the shadow half could run anywhere — including as a scheduled CI job, since it spends no model
 * context at all. This installer is deliberately small so that migration is cheap, not so that it is permanent.
 *
 * WHY `StartInterval` AND NOT `KeepAlive`: the shadow pass is a one-shot that exits, and it holds its own TTL
 * singleton lease, so a periodic fire is the entire daemon. The drain daemon's resident `KeepAlive` shape
 * (#2501 Fork B) becomes necessary only at the enforce flip, when a pass spawns a panel and an editor subagent
 * and wants to survive across them. Buying that supervision now would be paying for a phase we have not
 * reached.
 *
 * Usage:
 *   node scripts/converge-daemon-install.mjs print      # render the plist to stdout, touch nothing
 *   node scripts/converge-daemon-install.mjs install    # write ~/Library/LaunchAgents/<label>.plist + bootstrap
 *   node scripts/converge-daemon-install.mjs status     # is it loaded? where does it log?
 *   node scripts/converge-daemon-install.mjs uninstall  # bootout + remove the plist
 */
import { pinDeveloperDir } from './lib/lane-git-hardening.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  resolvePassConfig, assertCloneNotInUse, probeCloneState, PROVISION_CMD,
} from './converge-daemon-pass.mjs';
import { detectScheduler, renderSystemdUnits, systemdUnitNames } from './lib/converge-daemon-schedulers.mjs';

/** Labelled by the repo that OWNS the source (WE), not by the drain daemon's plateau-app prefix. */
export const LABEL = 'com.webeverything.converge-daemon';
/** 15 minutes. The pass is read-only `gh` traffic against a handful of parked PRs — a tighter interval buys no
 *  freshness that matters and just burns API budget. The drain daemon's 60 s is a LANDING loop; this is not. */
export const DEFAULT_INTERVAL_SEC = 900;

/** XML-escape a plist string value. Paths with `&` are rare but a silently-corrupt plist is worse than rare. */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The plist path for a label. PURE.
 * @param {string} [label]
 * @param {string} [home]
 * @returns {string}
 */
export function plistPath(label = LABEL, home = homedir()) {
  return join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

/**
 * Resolve the install config — the pass config plus the launchd-only bits. PURE.
 * @param {Record<string,string|undefined>} [env]
 * @param {string} [home]
 * @param {string} [nodePath]
 * @returns {object}
 */
export function resolveInstallConfig(env = process.env, home = homedir(), nodePath = process.execPath) {
  const pass = resolvePassConfig(env, home);
  const rawInterval = Number(env.CONVERGE_DAEMON_INTERVAL_SEC);
  return {
    ...pass,
    developerDir: env.DEVELOPER_DIR,
    label: LABEL,
    node: nodePath,
    // The daemon runs the script FROM ITS OWN CLONE — so a self-update (the pass's `reset --hard origin/main`)
    // takes effect on the next fire with no reinstall. Pointing this at the primary checkout would make the
    // operator's working tree the daemon's source, which is exactly what #2501 Fork A(a) forbids.
    script: join(pass.clone, 'scripts', 'converge-daemon-pass.mjs'),
    intervalSec: Number.isFinite(rawInterval) && rawInterval > 0 ? Math.floor(rawInterval) : DEFAULT_INTERVAL_SEC,
    stdoutPath: join(pass.stateRoot, 'daemon.log'),
  };
}

/**
 * Render the launchd plist. PURE — every input is in `cfg`, so the rendering is testable without touching
 * `~/Library/LaunchAgents`.
 * @param {object} cfg
 * @returns {string}
 */
export function renderPlist(cfg) {
  const envPairs = [
    ['PATH', `${resolve(cfg.node, '..')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`],
    ['CONVERGE_DAEMON_CLONE', cfg.clone],
    ['CONVERGE_DAEMON_PRIMARY', cfg.primary],
    ['CONVERGE_DAEMON_STATE_ROOT', cfg.stateRoot],
    // The ledger wire (see converge-daemon-pass.mjs) — WITHOUT this the daemon reads its own clone's empty
    // `.conveyor/jury` and every PR folds fail-closed, so the soak would record a wall of keep-parked and mean
    // nothing. Read-only: the daemon never writes into the primary tree.
    ['CONVERGE_DAEMON_JURY_DIR', cfg.juryDir],
  ];
  const developerEnv = pinDeveloperDir({ DEVELOPER_DIR: cfg.developerDir }, { exists: cfg.exists ?? existsSync });
  if (developerEnv.DEVELOPER_DIR) envPairs.push(['DEVELOPER_DIR', developerEnv.DEVELOPER_DIR]);
  if (cfg.repo) envPairs.push(['CONVERGE_DAEMON_REPO', cfg.repo]);

  const envXml = envPairs
    .map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(cfg.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(cfg.node)}</string>
    <string>${esc(cfg.script)}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(cfg.clone)}</string>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${cfg.intervalSec}</integer>
  <key>StandardOutPath</key><string>${esc(cfg.stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${esc(cfg.stdoutPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`;
}

/**
 * The preflight failures that must block an install, as messages. PURE (the caller supplies the existence
 * checks) so the whole refusal set is testable.
 * @param {object} cfg
 * @param {(p:string)=>boolean} exists
 * @param {(c:string)=>{dirty:boolean,ahead:boolean,lease:object|null}} [probe] - injectable in-use probe
 * @returns {string[]}
 */
export function installBlockers(cfg, exists, probe = probeCloneState) {
  const out = [];
  if (resolve(cfg.clone) === resolve(cfg.primary)) {
    out.push(`the daemon clone resolves to the PRIMARY checkout (${cfg.primary}) — a pass runs git reset --hard there. Set CONVERGE_DAEMON_CLONE.`);
  }
  if (!exists(cfg.clone)) {
    out.push(`no clone at ${cfg.clone} — provision it: ${PROVISION_CMD}`);
  } else {
    if (!exists(cfg.script)) {
      out.push(`the clone at ${cfg.clone} has no scripts/converge-daemon-pass.mjs — refresh it to a main that contains this change.`);
    }
    // Catch the in-use clone HERE too, not only at pass time: scheduling a job that resets a lane someone is
    // working in is a mistake worth refusing at install, when a human is present to read the refusal.
    const inUse = assertCloneNotInUse(cfg.clone, probe(cfg.clone));
    if (inUse) out.push(inUse.replace(/^converge-daemon: refusing to run from /, 'the daemon clone '));
  }
  if (!exists(cfg.juryDir)) {
    // NOT fatal on its own, but silence here is how a soak ends up recording nothing: an absent ledger dir
    // folds every PR to keep-parked, which looks like a working daemon and is not.
    out.push(`no jury ledger dir at ${cfg.juryDir} — the shadow fold would keep every PR parked. Run a convergence pass first, or set CONVERGE_DAEMON_JURY_DIR.`);
  }
  return out;
}

// ── the CLI (gated on direct invocation) ──────────────────────────────────────────────────────────────────────
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) process.exitCode = main(process.argv.slice(2));

function launchctl(...args) {
  return spawnSync('launchctl', args, { encoding: 'utf8' });
}

function systemctl(...args) {
  return spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
}

/**
 * The ordered `systemctl --user` calls an install makes, once the unit files are on disk. PURE.
 *
 * SEPARATE AND EXPORTED because the ORDER is the correctness property, and it had no test: `enable --now` is
 * a NO-OP on a timer that is already active, so a second `install` carrying a changed interval or clone wrote
 * new unit files and left the RUNNING timer on the old ones — silently diverging from the config the operator
 * believes is installed (review-pr correctness juror on #1465). The launchd path never had this bug: it
 * `bootout`s first, "so a re-install picks up the new plist". This path claimed to mirror it and did not.
 *
 * `decides` marks the ONE call whose exit code decides the command's own. `daemon-reload` and `stop` are
 * deliberately unchecked: on a first install there is nothing to stop, and that benign no-op must not be
 * reported as a failed install.
 */
export function systemdInstallSteps(timerUnit) {
  return [
    { args: ['daemon-reload'], decides: false },
    { args: ['stop', timerUnit], decides: false },
    { args: ['enable', '--now', timerUnit], decides: true },
  ];
}

/** `~/.config/systemd/user/<unit>` for each unit this label owns. */
function unitPaths(label, home = homedir()) {
  const dir = join(home, '.config', 'systemd', 'user');
  const { service, timer } = systemdUnitNames(label);
  return { dir, service: join(dir, service), timer: join(dir, timer), timerUnit: timer };
}

/**
 * The systemd half of the CLI. Same commands, same preflight, same refusals — only the scheduler differs.
 * Kept beside the launchd body rather than abstracted into one: the two inits disagree about enough
 * (bootout-vs-disable, plist-vs-two-units, exit-code meanings) that a shared wrapper would hide more than it
 * saved. What IS shared — the config and the blockers — is genuinely shared.
 */
/**
 * EVERYTHING `systemdMain` TOUCHES OUTSIDE ITSELF (#3197).
 *
 * `systemdInstallSteps` was extracted and tested because the ORDER is the correctness property — but nothing
 * tested that the orchestration actually RUNS them in that order, or that only the `decides` step reaches the
 * exit code. That is exactly where the #1465 juror's finding lived: `enable --now` is a no-op on a timer that
 * is already active, so a re-install wrote new unit files and left the RUNNING timer on the old ones. A test
 * of the pure step list cannot see that. A test of its caller can.
 */
export function systemdIo() {
  return {
    systemctl,
    exists: existsSync,
    // `installBlockers` shells git through this. It belongs in the bag for the reason the rest does: a test of
    // the ORCHESTRATION that still spawns git is not testing the orchestration, and it fails on a host where
    // the daemon clone happens not to exist.
    probe: probeCloneState,
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    writeFile: (path, content) => writeFileSync(path, content),
    rm: (path) => rmSync(path, { force: true }),
    out: (text) => process.stdout.write(text),
    errOut: (text) => process.stderr.write(text),
  };
}

export function systemdMain(cmd, cfg, argv, io = systemdIo()) {
  const u = unitPaths(cfg.label);
  const units = renderSystemdUnits(cfg);

  if (cmd === 'print') {
    io.out(`# ${u.service}\n${units.service}\n# ${u.timer}\n${units.timer}`);
    return 0;
  }

  if (cmd === 'status') {
    const enabled = io.systemctl('is-enabled', u.timerUnit);
    const active = io.systemctl('is-active', u.timerUnit);
    io.out(`${JSON.stringify({
      label: cfg.label, scheduler: 'systemd',
      // `is-enabled`/`is-active` exit non-zero for "no" as well as for "unknown unit", so report their WORD,
      // not a boolean derived from the exit code — the two are different states to an operator.
      timerEnabled: (enabled.stdout || '').trim() || 'unknown',
      timerActive: (active.stdout || '').trim() || 'unknown',
      units: [u.service, u.timer], unitsPresent: io.exists(u.service) && io.exists(u.timer),
      clone: cfg.clone, juryDir: cfg.juryDir, intervalSec: cfg.intervalSec,
      log: cfg.stdoutPath, shadowLog: cfg.logPath,
    }, null, 2)}\n`);
    return 0;
  }

  if (cmd === 'uninstall') {
    const off = io.systemctl('disable', '--now', u.timerUnit);
    // Remove the unit files whatever disable did — otherwise a daemon-reload brings the timer back.
    try { io.rm(u.service); io.rm(u.timer); } catch { /* already gone */ }
    io.systemctl('daemon-reload');
    const stderrText = `${off.stderr || ''}`;
    const wasNotLoaded = off.status === 0 || /not loaded|does not exist|no such file/i.test(stderrText);
    if (!wasNotLoaded) {
      io.errOut(`converge-daemon: removed the unit files (so the timer will NOT return at login), but `
        + `\`systemctl --user disable --now ${u.timerUnit}\` failed — it may still be running right now.\n`
        + `  ${stderrText.trim() || `exit ${off.status}`}\n`);
      return 1;
    }
    io.out(`converge-daemon: disabled ${u.timerUnit} and removed its unit files\n`);
    return 0;
  }

  if (cmd !== 'install') {
    io.errOut('usage: converge-daemon-install.mjs <install|uninstall|status|print> [--force]\n');
    return 2;
  }

  const blockers = installBlockers(cfg, io.exists, io.probe);
  if (blockers.length && !argv.includes('--force')) {
    io.errOut(`converge-daemon: refusing to install —\n${blockers.map((b) => `  · ${b}`).join('\n')}\n`
      + '  (--force installs anyway)\n');
    return 2;
  }

  io.mkdir(cfg.stateRoot);
  io.mkdir(u.dir);
  io.writeFile(u.service, units.service);
  io.writeFile(u.timer, units.timer);

  let on;
  for (const s of systemdInstallSteps(u.timerUnit)) {
    const r = io.systemctl(...s.args);
    if (s.decides) on = r;
  }
  if (on.status !== 0) {
    io.errOut(`converge-daemon: wrote the unit files but \`systemctl --user enable --now ${u.timerUnit}\` `
      + `failed — ${(on.stderr || '').trim()}\n`
      + '  On a headless box the user manager may not be running: `loginctl enable-linger $USER`.\n');
    return 1;
  }
  io.out(`converge-daemon: installed ${u.timerUnit} (every ${cfg.intervalSec}s, from ${cfg.clone})\n`
    + `  shadow log: ${cfg.logPath}\n  stdout/err: ${cfg.stdoutPath}\n`);
  return 0;
}

function main(argv) {
  const cmd = argv.find((a) => !a.startsWith('-')) || 'status';
  const cfg = resolveInstallConfig();

  // Which init schedules this is the ONLY thing the host decides. The pass, the config and the refusals are
  // the same everywhere — see the header of lib/converge-daemon-schedulers.mjs for what a Linux host does and
  // does not unblock (it does NOT make this runnable inside a managed cloud VM).
  const { scheduler, reason } = detectScheduler(process.platform, existsSync);
  if (!scheduler) {
    process.stderr.write(`converge-daemon: ${reason}\n`);
    return 2;
  }
  if (scheduler === 'systemd') return systemdMain(cmd, cfg, argv);

  const target = `gui/${process.getuid()}`;
  const path = plistPath(cfg.label);

  if (cmd === 'print') {
    process.stdout.write(renderPlist(cfg));
    return 0;
  }

  if (cmd === 'status') {
    const listed = launchctl('list', cfg.label);
    process.stdout.write(`${JSON.stringify({
      label: cfg.label,
      loaded: listed.status === 0,
      plist: path,
      plistPresent: existsSync(path),
      clone: cfg.clone,
      juryDir: cfg.juryDir,
      intervalSec: cfg.intervalSec,
      log: cfg.stdoutPath,
      shadowLog: cfg.logPath,
    }, null, 2)}\n`);
    return 0;
  }

  if (cmd === 'uninstall') {
    const out = launchctl('bootout', `${target}/${cfg.label}`);
    // Remove the plist FIRST-class, whatever bootout did — without it the job comes back at the next login.
    try { rmSync(path, { force: true }); } catch { /* already gone */ }
    // launchctl exits non-zero when the job simply was not loaded; that is the benign case. Anything else means
    // the job may STILL be running, and reporting "booted out" there would tell the operator it is off when it is
    // not — the one lie an uninstall command must never tell.
    const stderr = `${out.stderr || ''}`;
    const wasNotLoaded = out.status === 0 || /no such process|could not find|not (loaded|find)/i.test(stderr);
    if (!wasNotLoaded) {
      process.stderr.write(`converge-daemon: removed ${path} (so it will NOT return at login), but \`launchctl bootout\` `
        + `failed — the job may still be loaded right now. Run: launchctl bootout ${target}/${cfg.label}\n`
        + `  ${stderr.trim() || `exit ${out.status}`}\n`);
      return 1;
    }
    process.stdout.write(`converge-daemon: booted out and removed ${path}\n`);
    return 0;
  }

  if (cmd !== 'install') {
    process.stderr.write(`usage: converge-daemon-install.mjs <install|uninstall|status|print> [--force]\n`);
    return 2;
  }

  const blockers = installBlockers(cfg, existsSync);
  if (blockers.length && !argv.includes('--force')) {
    process.stderr.write(`converge-daemon: refusing to install —\n${blockers.map((b) => `  · ${b}`).join('\n')}\n`
      + '  (--force installs anyway)\n');
    return 2;
  }

  mkdirSync(cfg.stateRoot, { recursive: true });
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(path, renderPlist(cfg));

  // bootout first so a re-install picks up the new plist; a missing job makes this a no-op, which is fine.
  launchctl('bootout', `${target}/${cfg.label}`);
  const boot = launchctl('bootstrap', target, path);
  if (boot.status !== 0) {
    process.stderr.write(`converge-daemon: wrote ${path} but launchctl bootstrap failed — ${(boot.stderr || '').trim()}\n`);
    return 1;
  }
  process.stdout.write(`converge-daemon: installed ${cfg.label} (every ${cfg.intervalSec}s, from ${cfg.clone})\n`
    + `  shadow log: ${cfg.logPath}\n  stdout/err: ${cfg.stdoutPath}\n`);
  return 0;
}
