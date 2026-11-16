/**
 * @file scripts/conveyor/health-smells/launchd-ops-copy-drift.mjs
 * @description A launchd job (label com.we.* / com.plateau.*) that runs a script from OUTSIDE any git checkout
 * (e.g. an ops/handoff copy) while a same-basename file exists under the repo can silently run a stale copy
 * (B3: a 3-day-stale sync-guard-clone.mjs). Compare the copy's content hash with `git show origin/main:<path>`;
 * differing -> a finding. Read-only and bounded: one `git show` per candidate, no network. Output carries only
 * labels, paths (home shown as ~) and hashes. Counterpart-less scripts are never flagged.
 * Probe-free: evaluate() runs the scan itself (registered by disk discovery; not yet in the notify list).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL_RE = /^com\.(we|plateau)\./;
const SCRIPT_RE = /\.(mjs|js|cjs|sh)$/;
const NOISE_RE = /(^|\/)(__tests__|fixtures?|archive[ds]?|node_modules)\//;
const DAY = 86_400_000;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export function scanLaunchdOpsCopyDrift(d) {
  const tilde = (p) => (p.startsWith(`${d.home}/`) ? `~${p.slice(d.home.length)}` : p);
  const findings = [];
  let names = [];
  try { names = d.listPlists(); } catch {
    return [{ severity: 'low', label: 'launchd-agents', coverageIncomplete: true, note: 'LaunchAgents directory unreadable; drift not checked' }];
  }
  for (const name of names) {
    const fallbackLabel = name.replace(/\.plist$/, '');
    const nameMatches = LABEL_RE.test(name);
    let plist;
    try { plist = d.readPlist(name); } catch {
      // A filename cannot recover the Label of an unreadable (possibly renamed) plist.
      if (!nameMatches && findings.some((f) => f.label === 'launchd-agents')) continue;
      findings.push({ severity: 'low', label: nameMatches ? fallbackLabel : 'launchd-agents', coverageIncomplete: true, note: `plist ${name} unreadable; drift not checked` });
      continue;
    }
    const label = typeof plist?.Label === 'string' ? plist.Label : fallbackLabel;
    if (!nameMatches && !LABEL_RE.test(label)) continue;
    const wd = typeof plist?.WorkingDirectory === 'string' && plist.WorkingDirectory.startsWith('/') ? plist.WorkingDirectory : null;
    const raw = [plist?.Program, ...(Array.isArray(plist?.ProgramArguments) ? plist.ProgramArguments : [])];
    const args = raw.filter((a) => typeof a === 'string').map((a) => (!a.startsWith('/') && wd && SCRIPT_RE.test(a) ? posix.join(wd, a) : a));
    for (const arg of args) {
      if (!arg.startsWith('/') || !SCRIPT_RE.test(arg)) continue;
      try {
        if (d.inGitCheckout(arg)) continue;
        const all = d.repoFilesByBasename(basename(arg));
        if (!all.length) continue;
        const repoPaths = all.filter((f) => !NOISE_RE.test(f));
        if (repoPaths.length !== 1) {
          findings.push({ severity: 'low', label, copyPath: tilde(arg), note: `${repoPaths.length ? 'ambiguous' : 'no live'} repo counterpart among ${all.join(', ')}; drift not checked` });
          continue;
        }
        const copyHash = d.hashCopy(arg);
        let matched = false;
        let mainHash = null;
        for (const rp of repoPaths) {
          mainHash = d.hashMain(rp);
          if (mainHash === copyHash) { matched = true; break; }
        }
        if (matched) continue;
        const repoPath = repoPaths[0];
        const staleDays = Math.max(0, Math.floor((d.mainCommitMs(repoPath) - d.copyMtimeMs(arg)) / DAY));
        findings.push({ severity: 'medium', label, copyPath: tilde(arg), repoPath, copyHash, mainHash, staleDays });
      } catch {
        findings.push({ severity: 'low', label, copyPath: tilde(arg), note: 'could not compare copy with origin/main; drift not checked' });
      }
    }
  }
  return findings;
}

export function realDeps({ home = homedir(), repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), exec = execFileSync } = {}) {
  const agents = join(home, 'Library', 'LaunchAgents');
  const git = (args, cwd = repoRoot) => exec('git', args, { cwd, encoding: 'buffer', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
  let tree = null;
  let treeError = null;
  return {
    home,
    listPlists: () => readdirSync(agents).filter((n) => n.endsWith('.plist')),
    readPlist: (n) => JSON.parse(exec('plutil', ['-convert', 'json', '-o', '-', join(agents, n)], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })),
    inGitCheckout: (p) => { try { git(['rev-parse', '--show-toplevel'], dirname(p)); return true; } catch { return false; } },
    repoFilesByBasename: (b) => {
      // Keep the one-tree-read bound even when every candidate encounters an unavailable ref.
      if (treeError) throw treeError;
      try {
        tree ??= git(['ls-tree', '-r', '--name-only', 'origin/main', '--', 'scripts']).toString('utf8').split('\n').filter(Boolean);
      } catch (error) { treeError = error; throw error; }
      return tree.filter((f) => basename(f) === b);
    },
    hashCopy: (p) => sha(readFileSync(p)),
    hashMain: (rp) => sha(git(['show', `origin/main:${rp}`])),
    copyMtimeMs: (p) => statSync(p).mtimeMs,
    mainCommitMs: (rp) => Number(git(['log', '-1', '--format=%ct', 'origin/main', '--', rp]).toString().trim()) * 1000,
  };
}

export default {
  id: 'launchd-ops-copy-drift', scope: 'host', cadence: 'every-tick', probes: [],
  openAfter: 2, closeAfter: 2, severity: 'medium', action: 'investigate',
  evaluate(_probes, ctx = {}) {
    const findings = [...(ctx.scan ?? (() => scanLaunchdOpsCopyDrift(realDeps())))()];
    if (findings.some((f) => f.coverageIncomplete)) {
      // Missing subjects normally count as clean. Carry persisted identities through incomplete scans,
      // including after watcher restarts, until a complete scan can establish recovery or removal.
      const seen = new Set(findings.map((f) => f.label));
      for (const ep of Object.values(ctx.episodes ?? {})) {
        if (ep.smell !== 'launchd-ops-copy-drift' || seen.has(ep.subject)) continue;
        findings.push({ severity: 'low', label: ep.subject, note: 'LaunchAgents scan incomplete; drift not checked' });
        seen.add(ep.subject);
      }
    }
    // Unknown (low) findings stay breaches: an unverifiable job must never read as a clean sample.
    return findings.map((f) => (f.severity === 'medium' ? {
      subject: f.label, breach: true, measure: { staleDays: f.staleDays, copyPath: f.copyPath, repoPath: f.repoPath },
      summary: `launchd job ${f.label} runs ${f.copyPath}, which differs from origin/main:${f.repoPath} (copy ${f.staleDays}d behind).`,
      recommendation: 'Point the job at the repo script or refresh the ops copy from origin/main.',
    } : {
      subject: f.label, breach: true, measure: { unverified: true, copyPath: f.copyPath },
      summary: `launchd job ${f.label}: ${f.note}`,
      recommendation: 'Fix the unreadable input so the drift check can run.',
    }));
  },
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(scanLaunchdOpsCopyDrift(realDeps()), null, 2));
}
