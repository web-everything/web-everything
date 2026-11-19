#!/usr/bin/env node
/** @file hot-patch.mjs - R1100 request, verify-result, pr and status CLI. Registration reuses daemon-overlay. */
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestHotPatch, recordVerifyResult, recordHotPatchPr, readHotPatch, listHotPatches } from './lib/hot-patch.mjs';
import { readForceWatch } from './lib/daemon-force-adopt.mjs';
import { readOverlayState } from './lib/daemon-overlays.mjs';
import { DAEMON_CLONE_SEED, daemonCloneForLabel } from './lib/daemon-clone-registry.mjs';
import { workspaceFor } from './lib/lane-pool-paths.mjs';
import { resolveHotPatchSettings } from './lib/hot-patch-settings.mjs';

export function hotPatchRoot(daemon, cwd) {
  const clone = daemonCloneForLabel(daemon) ?? (DAEMON_CLONE_SEED.includes(daemon) ? daemon : null);
  if (clone) return join(workspaceFor(cwd), clone);
  if (daemon && (isAbsolute(daemon) || daemon.includes('/'))) return resolve(cwd, daemon);
  throw new Error('unknown daemon; use its registered label, clone name or explicit clone path');
}

/** ET ISO timestamps include the date-specific offset, including daylight saving time. */
export function easternIso(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' })
    .formatToParts(new Date(value));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.timeZoneName.replace('GMT', '')}`;
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env,
  run = spawnSync, stdout = s => process.stdout.write(s), stderr = s => process.stderr.write(s) } = {}) {
  const clean = s => String(s).replace(/[\x00-\x1f\x7f]/g, '');
  try {
    const [command, ...args] = argv;
    const { values: f } = parseArgs({ args, options: {
      daemon: { type: 'string' }, branch: { type: 'string' }, sha: { type: 'string' }, kind: { type: 'string' },
      files: { type: 'string' }, result: { type: 'string' }, pr: { type: 'string' }, queued: { type: 'boolean' },
    } });
    if (f.sha) f.sha = f.sha.toLowerCase();
    const root = f.daemon ? hotPatchRoot(f.daemon, cwd) : null;
    const settings = resolveHotPatchSettings({ env });
    const invoke = (cmd, args, timeout = settings.ioTimeoutMs) => {
      const r = run(cmd, args, { cwd, env: cmd === 'git' ? { ...env, GIT_NO_LAZY_FETCH: '1' } : env,
        encoding: 'utf8', timeout, maxBuffer: settings.maxOutputBytes });
      if (r.status !== 0 || r.error) throw new Error(`command refused: ${r.error?.message ?? r.stderr ?? r.status}`);
      return r.stdout;
    };
    if (command === 'status') {
      const records = root ? [readHotPatch(root, env)].filter(Boolean) : listHotPatches(env);
      stdout(JSON.stringify(records.map(record => {
        const watch = readForceWatch(record.root, env);
        return { ...record, owed: { ...record.owed, prBy: easternIso(record.owed.prBy), mergeBy: easternIso(record.owed.mergeBy) },
          watch: watch ? { ticksLeft: watch.ticksLeft, minUntil: watch.minUntil ? easternIso(watch.minUntil) : null } : null };
      }), null, 2) + '\n');
      return 0;
    }
    if (!root) throw new Error('--daemon is required');
    let result;
    if (command === 'request') {
      if (!/^[a-f0-9]{40}$/.test(f.sha ?? '')) throw new Error('--sha requires a full lowercase 40-hex commit');
      if (!settings.eligibleKinds.includes(f.kind)) throw new Error('ineligible-kind');
      const git = args => {
        try { return invoke('git', ['--no-replace-objects', '-c', 'protocol.allow=never', ...args]); }
        catch (e) { throw new Error(`diff evidence unavailable: ${e.message}; repair local Git objects or use ordinary delivery`); }
      };
      const pin = ref => {
        const value = git(['rev-parse', '--verify', `${ref}^{commit}`]);
        if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value.trim()))
          throw new Error('commit evidence unreadable; repair local Git objects or use ordinary delivery');
        return value.trim();
      };
      const base = pin('origin/main');
      if (pin(f.sha) !== f.sha) throw new Error('--sha must identify the registered commit itself');
      // Pin both trees. Disabling rename detection lists both endpoints as deletion/addition.
      const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none',
        '--name-only', '-z', '--no-renames', `${base}..${f.sha}`, '--']);
      if (typeof diff !== 'string' || (diff && !diff.endsWith('\0')))
        throw new Error('incomplete diff evidence; repair local Git objects or use ordinary delivery');
      const files = diff ? diff.slice(0, -1).split('\0') : [];
      if (f.files !== undefined) {
        const supplied = f.files.split(',');
        const complete = new Set(files);
        if (supplied.length > settings.maxFiles || supplied.some(p => p.length > settings.maxPathChars || !complete.has(p))
          || new Set(supplied).size !== complete.size)
          throw new Error('--files must match the complete commit diff; omit --files to derive it or use ordinary delivery');
      }
      const request = { root, env, daemon: f.daemon, branch: f.branch, sha: f.sha, files, kind: f.kind };
      result = await requestHotPatch({ ...request, dryRun: true });
      if (result.ok) {
        const before = readOverlayState(root, { env });
        if (before.corrupt || before.overlays.some(o => o.ref === f.branch)) throw new Error('overlay state unreadable or branch already registered; use a fresh branch');
        result = await requestHotPatch({ ...request, registerOverlay: () => invoke(process.execPath,
          [join(dirname(fileURLToPath(import.meta.url)), 'daemon-overlay.mjs'), 'add',
            `--clone=${root}`, `--ref=${f.branch}`, `--expected-sha=${f.sha}`, '--pinned', '--allow-no-pr', '--reason=R1100 hot-patch', '--json'], settings.registrationTimeoutMs) });
      }
    } else if (command === 'verify-result') result = await recordVerifyResult({ root, env, sha: f.sha, result: f.result });
    else if (command === 'pr') result = recordHotPatchPr({ root, env, sha: f.sha, pr: Number(f.pr), inMergeQueue: f.queued });
    else throw new Error('usage: hot-patch.mjs request|verify-result|pr|status [--daemon clone]');
    stdout(JSON.stringify(result) + '\n');
    if (!result.ok) stderr(`hot-patch: refused: ${clean(result.reason)}\n`);
    return result.ok ? 0 : 1;
  } catch (e) { stderr(`hot-patch: refused: ${clean(e.message)}\n`); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
