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
const SCRIPT_TEXT_RE = /[\w@%+=:,.-]+\.(?:mjs|js|cjs|sh)\b/;
const SHELL_RE = /^(?:sh|bash|dash|ash|zsh|ksh|fish|csh|tcsh)$/;
// Launchers that run the next command: a shell after one of them is still a shell command line.
const WRAPPER_RE = /^(?:env|nice|nohup|caffeinate|arch|exec|time|timeout|sudo|command|xcrun|stdbuf|setsid)$/;
const NOISE_RE = /(^|\/)(__tests__|fixtures?|archive[ds]?|node_modules)\//;
const DAY = 86_400_000;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const ENV_SPLIT_RE = /^(?:--split-string(?:=|$)|-[^-=]*S)/;

// Split a shell-ish command line into words (whitespace, single/double quotes, backslash).
// Returns null for unbalanced quotes or a trailing escape: the caller must treat that as unverifiable.
function splitWords(text) {
  const words = [];
  let cur = '';
  let inWord = false;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = null; else cur += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < text.length) cur += text[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === '\\') { if (i + 1 >= text.length) return null; cur += text[++i]; inWord = true; continue; }
    if (/\s/.test(c)) { if (inWord) { words.push(cur); cur = ''; inWord = false; } continue; }
    cur += c; inWord = true;
  }
  if (quote) return null;
  if (inWord) words.push(cur);
  return words;
}

// Replace each `env -S <string>` / `-S<string>` / `--split-string[=]<string>` argument by its words.
// Returns null when a split string is missing or cannot be split with certainty.
function expandEnvSplitStrings(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let text = null;
    if (i > 0 && typeof a === 'string') {
      if (a === '--split-string') text = argv[++i];
      else if (a.startsWith('--split-string=')) text = a.slice('--split-string='.length);
      else if (/^-[^-=]*S/.test(a)) {
        const rest = a.slice(a.indexOf('S') + 1);
        text = rest === '' ? argv[++i] : rest;
      } else { out.push(a); continue; }
      // env's escapes (e.g. \_), variable expansion and comment syntax are not shell
      // quoting. Keep unsupported syntax unverified instead of comparing a guessed path.
      if (typeof text !== 'string' || /[\\$#]|[^\S\t\n\r\v\f ]/.test(text)) return null;
      const words = splitWords(text);
      // Nested split options require another env parse; an empty split supplies no command.
      if (!words?.[0] || words.some((word) => ENV_SPLIT_RE.test(word))) return null;
      out.push(...words);
      continue;
    }
    out.push(a);
  }
  return out;
}

export function scanLaunchdOpsCopyDrift(d) {
  const tilde = (p) => (p.startsWith(`${d.home}/`) ? `~${p.slice(d.home.length)}` : p);
  const findings = [];
  const scannedLabels = new Set();
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
    scannedLabels.add(label);
    const wd = typeof plist?.WorkingDirectory === 'string' && plist.WorkingDirectory.startsWith('/') ? plist.WorkingDirectory : null;
    const plistArgv = Array.isArray(plist?.ProgramArguments) ? plist.ProgramArguments : [];
    const program = typeof plist?.Program === 'string' ? plist.Program : plistArgv[0];
    const executable = typeof program === 'string' ? basename(program) : '';
    // `env -S <string>` splits one argument into a command line; inspect the real tokens, and
    // fail closed (unverified) when the string cannot be split with certainty.
    const wrappedEnv = WRAPPER_RE.test(executable) && plistArgv.some((a, i) =>
      i > 0 && typeof a === 'string' && basename(a) === 'env');
    const expanded = executable === 'env' || wrappedEnv ? expandEnvSplitStrings(plistArgv) : plistArgv;
    if (!expanded) {
      findings.push({ severity: 'low', label, note: 'shell command cannot be verified; drift not checked' });
      continue;
    }
    const argv = expanded;
    const raw = [plist?.Program, ...argv];
    const shellArgsStart = SHELL_RE.test(executable) ? 1 : WRAPPER_RE.test(executable)
      ? argv.findIndex((a, i) => i > 0 && typeof a === 'string' && SHELL_RE.test(basename(a))) + 1 : 0;
    // Shell text can contain quoting, substitutions, pipelines or relative paths. Do not
    // execute it or guess which script it runs: retain this job as explicitly unverified.
    if (shellArgsStart > 0 && argv.slice(shellArgsStart).some((a) => typeof a === 'string'
      && (/^-[^-]*c/.test(a) || a === '--command' || a.startsWith('--command=')))) {
      findings.push({ severity: 'low', label, note: 'shell command cannot be verified; drift not checked' });
      continue;
    }
    // Program and ProgramArguments often name the same script: check each distinct path once per job.
    const args = [...new Set(raw.filter((a) => typeof a === 'string').map((a) => (!a.startsWith('/') && !a.startsWith('-') && wd && SCRIPT_RE.test(a) ? posix.join(wd, a) : a)))];
    let unresolvedScript = false;
    for (const arg of args) {
      if (!arg.startsWith('/') || !SCRIPT_RE.test(arg)) {
        if (SCRIPT_TEXT_RE.test(arg)) unresolvedScript = true;
        continue;
      }
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
    // The command names a script (`node -e require("…/x.mjs")`, `--import=…/x.mjs`, a relative path
    // without WorkingDirectory) that could not be resolved: another verified path cannot classify it.
    // evaluate() holds an already-open episode open for it and ignores it otherwise.
    if (unresolvedScript) {
      findings.push({ severity: 'low', label, unclassified: true, note: 'job command not classified; drift not checked' });
    }
  }
  // Include clean-label evidence on incomplete results, preserving the array/CLI contract.
  // Any finding for a label wins over a clean duplicate plist, regardless of scan order.
  const unverifiedLabels = new Set(findings.map((f) => f.label));
  const verifiedCleanLabels = [...scannedLabels].filter((label) => !unverifiedLabels.has(label));
  const incomplete = findings.find((f) => f.coverageIncomplete);
  if (incomplete) incomplete.verifiedCleanLabels = verifiedCleanLabels;
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
    const open = new Set(Object.values(ctx.episodes ?? {}).filter((ep) => ep.smell === 'launchd-ops-copy-drift').map((ep) => ep.subject));
    // An unclassified job only holds an existing episode open; it never opens a new one.
    const findings = [...(ctx.scan ?? (() => scanLaunchdOpsCopyDrift(realDeps())))()]
      .filter((f) => !f.unclassified || open.has(f.label));
    if (findings.some((f) => f.coverageIncomplete)) {
      // Missing subjects normally count as clean. Carry persisted identities through incomplete scans,
      // including after watcher restarts. A readable, verified job can recover independently.
      const seen = new Set(findings.map((f) => f.label));
      const verifiedClean = new Set(findings.filter((f) => f.coverageIncomplete).flatMap((f) => f.verifiedCleanLabels ?? []));
      for (const ep of Object.values(ctx.episodes ?? {})) {
        if (ep.smell !== 'launchd-ops-copy-drift' || seen.has(ep.subject) || verifiedClean.has(ep.subject)) continue;
        findings.push({ severity: 'low', label: ep.subject, note: 'LaunchAgents scan incomplete; drift not checked' });
        seen.add(ep.subject);
      }
    }
    // Unknown (low) findings stay breaches: an unverifiable job must never read as a clean sample.
    // One observation per job label per tick, so a job with several findings (or duplicate plists)
    // advances its episode streaks once. A confirmed drift wins over an unverified note.
    const perLabel = new Map();
    for (const f of findings) {
      const prev = perLabel.get(f.label);
      if (!prev || (prev.severity !== 'medium' && f.severity === 'medium')) perLabel.set(f.label, f);
    }
    return [...perLabel.values()].map((f) => (f.severity === 'medium' ? {
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
