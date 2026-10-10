#!/usr/bin/env node
/**
 * @file scripts/conveyor/github-app-status.mjs
 * @description ONE-COMMAND READ of whatever `we:scripts/lib/github-app-auth-env.mjs#ensureFreshGithubAppEnv`
 *   last recorded (#x8mpubm) — the fix for the specific way plateau-app PR #181's review session failed
 *   (`GraphQL: API rate limit already exceeded for user ID 760299`, the operator's PERSONAL account, not the
 *   App). Root cause there: the registered App installation had none of the required permissions or repo
 *   access, so `ensureFreshGithubAppEnv`'s fail-safe correctly refused to apply it on EVERY tick since the App
 *   was registered — but the only trace of that was a repeated line in one daemon's own log file, so nobody
 *   noticed until a live rate-limit incident made it visible the hard way. This script turns that log line
 *   into a one-command answer, for an operator or a future monitoring skill (`runner-status`/
 *   `why-not-dispatching`), with the EXACT remediation the fail-safe already computed (which permissions,
 *   which repos) rather than a bare "false".
 *
 * READS ONLY — never mints, never mutates `process.env`, never touches the private key. The status file it
 * reads is written by every real `ensureFreshGithubAppEnv` call (every daemon tick, every drain pass that
 * opts in), so this is only ever as fresh as the last of those — a process that has never run leaves no
 * status file at all, reported as its own distinct case rather than a false "applied".
 *
 * PURE CORE / IO SHELL: {@link formatGithubAppStatus} is pure (a status object or null in, a string out);
 * `main()` is the only IO (one file read via {@link readGithubAppStatus}, one stdout write).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGithubAppStatus, defaultStatusPath } from '../lib/github-app-auth-env.mjs';

/**
 * PURE: render a status record (or `null`, meaning "no process has ever recorded one") as a plain-language
 * report. Never throws — an unrecognised `reason` still renders, naming itself, rather than crashing a
 * status check on a future reason this file has not been taught yet.
 * @param {{applied:boolean, reason:string, missingPermissions?:string[], missingRepos?:string[], checkedAt?:string}|null} status
 * @returns {string}
 */
export function formatGithubAppStatus(status) {
  if (!status) {
    return 'github-app-status: no status recorded yet — no process has called ensureFreshGithubAppEnv on this '
      + 'host (App auth is either not opted into anywhere, or nothing configured with it has run since boot).';
  }
  const tail = formatCallerLines(status.callers);
  if (status.applied === undefined && status.reason === undefined) {
    return ['github-app-status: no shared status recorded yet.', ...tail].join('\n');
  }
  const when = status.checkedAt ? ` (as of ${status.checkedAt})` : '';
  if (status.applied) {
    return [`github-app-status: APPLIED${when} — gh calls are authenticating as the App installation, not the operator's personal token.`, ...tail].join('\n');
  }
  const lines = [`github-app-status: NOT APPLIED${when} — reason: ${status.reason}.`];
  if (status.reason === 'not-configured') {
    lines.push('  This process has not opted in (WE_GITHUB_APP_ID / WE_GITHUB_APP_INSTALLATION_ID / WE_GITHUB_APP_PRIVATE_KEY_PATH unset) — gh calls draw on the operator\'s personal auth by design.');
  } else if (status.reason === 'mint-failed') {
    lines.push('  The last mint attempt failed (transient network/API error) — gh calls are falling back to the operator\'s personal auth until the next refresh succeeds.');
  } else if (status.reason === 'insufficient-access') {
    lines.push('  The App installation is missing access it needs — gh calls are falling back to the operator\'s personal auth until this is granted on github.com:');
    if (status.missingPermissions?.length) lines.push(`    grant repository permissions: ${status.missingPermissions.join(', ')}`);
    if (status.missingRepos?.length) lines.push(`    add repositories to the installation: ${status.missingRepos.join(', ')}`);
  } else if (status.reason === 'half-configured') {
    lines.push('  App auth is HALF-configured (some WE_GITHUB_APP_* vars set, or the key unreadable) — gh calls run on the operator\'s personal login. Set the missing value(s) and reload the daemon.');
  } else if (status.reason === 'policy-personal') {
    lines.push('  github.auth=personal (we:scripts/settings/github-auth.json or WE_GITHUB_AUTH) — the personal login is used by policy.');
  } else if (status.reason === 'access-check-failed') {
    lines.push('  Couldn\'t verify the App installation\'s repository access this tick (the mint itself succeeded — this is NOT a confirmed gap, just an unread check) — gh calls are falling back to the operator\'s personal auth until the next tick can verify.');
  }
  return [...lines, ...tail].join('\n');
}

/**
 * PURE: one line per caller (daemon/pass) whose last refresh did NOT apply the App — a half-configured plist, a
 * daemon with no App config, a per-daemon mint failure. Callers on the App are summarised in one count line.
 * @param {{caller:string, applied:boolean, reason:string, missing?:string[], keyUnreadable?:boolean, checkedAt?:string}[]|undefined} callers
 * @returns {string[]}
 */
export function formatCallerLines(callers) {
  if (!Array.isArray(callers) || !callers.length) return [];
  const bad = callers.filter((c) => !c.applied);
  const out = [`  per-caller: ${callers.length - bad.length}/${callers.length} on the App installation.`];
  for (const c of bad) {
    const detail = c.reason === 'half-configured'
      ? ` — missing ${[...(c.missing ?? []), ...(c.keyUnreadable ? ['readable private key'] : [])].join(', ') || '?'}`
      : '';
    out.push(`  PERSONAL: ${c.caller} (${c.reason}${detail}${c.checkedAt ? `, ${c.checkedAt}` : ''})`);
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const status = readGithubAppStatus(defaultStatusPath());
  if (argv.includes('--json')) {
    console.log(JSON.stringify(status));
  } else {
    console.log(formatGithubAppStatus(status));
  }
  // Exit non-zero on anything but a confirmed `applied: true` — makes this scriptable as a health-check gate,
  // not just a human-readable report. `no status recorded yet` and every `applied: false` reason all count as
  // "not currently applying the App token", which is the one fact a caller polling this needs.
  return status?.applied ? 0 : 1;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  process.exitCode = main();
}
