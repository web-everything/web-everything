/**
 * @file we:scripts/operations/worker-pause.mjs
 * R480 pause-flag CLI. `node scripts/operations/run.mjs worker-pause --owner=X [--reason=… --resume-when=…]` sets a flag;
 * `--resume [--owner=X]` clears it (no owner = every flag); `--list` shows live flags; `--tick` runs one governor step
 * (reads the load, pauses/resumes holdable owners given as --owners=a,b). Workers check the flag at each safe point.
 */
import { loadavg, cpus, homedir } from 'node:os';
import { join } from 'node:path';
import { readSettings } from '../lib/settings-files.mjs';
import { writeLineSync } from '../lib/write-all-sync.mjs';
import { resolveGovernorSettings, setPause, clearPause, listPauses, governorTick, validOwner, appendEvents, defaultPauseDir } from '../lib/load-governor.mjs';

export function parseArgs(argv) {
  const o = {};
  for (const a of argv) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) o[m[1]] = m[2] ?? true; }
  return o;
}
export function main(argv, { out = (s) => writeLineSync(1, s),settings, dir = defaultPauseDir(), now = new Date(), load = () => loadavg()[0] / cpus().length, home = homedir() } = {}) {
  const a = parseArgs(argv);
  // boolean flags take no value (`--resume=` / `--resume=0` would otherwise take a different path than bare `--resume`); value flags need one
  const bad = ['list', 'tick', 'resume'].filter((k) => k in a && a[k] !== true).map((k) => `--${k} takes no value`)
    .concat(['owners', 'reason', 'resume-when'].filter((k) => k in a && typeof a[k] !== 'string').map((k) => `--${k} needs a value`));
  if (bad.length) { out(`error: ${bad.join('; ')}`); return 2; }
  // Unknown flags, typos (`--ower=a`), positionals (`--resume a`) and flags the chosen mode ignores (`--resume --owners=a`) must not
  // fall through to a broader action (bare --resume clears EVERY flag): refuse them all.
  const mode = a.list ? 'list' : a.tick ? 'tick' : a.resume ? 'resume' : 'pause';
  const allowed = { list: ['list'], tick: ['tick', 'owners'], resume: ['resume', 'owner'], pause: ['owner', 'reason', 'resume-when'] }[mode];
  const stray = argv.filter((t) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(t); return !m || !allowed.includes(m[1]); });
  if (stray.length) { out(`error: unexpected argument(s) for ${mode}: ${stray.map((t) => JSON.stringify(t)).join(', ')}`); return 2; }
  const s = settings ?? resolveGovernorSettings({ settings: readSettings(), env: process.env });
  if (a.list) { const l = listPauses({ dir, maxPauseMinutes: s.maxPauseMinutes, now }); out(l.length ? l.map((x) => `${x.owner}\t${x.flag.at}\t${x.flag.reason}`).join('\n') : 'no live pause flags'); return 0; }
  if (a.tick) {
    let lpc = NaN; try { lpc = load(); } catch { /* unreadable */ }
    const owners = String(a.owners ?? '').split(',').filter(Boolean).map((owner) => ({ owner, text: owner }));
    const r = governorTick({ loadPerCore: lpc, owners, settings: s, dir, now, stateFile: join(home, '.claude', 'conveyor', 'load-governor-state.json'),
      log: (row) => appendEvents(join(home, '.claude', 'conveyor', 'load-governor-events.jsonl'), row) });
    out(`${r.holding ? 'HOLDING' : 'open'} (${r.reason}); events: ${r.events.map((e) => `${e.event}:${e.owner ?? ''}`).join(', ') || 'none'}`);
    return 0;
  }
  if (a.resume) {
    if ('owner' in a && !validOwner(a.owner)) { out('error: --owner needs a valid owner name (use --resume alone to clear every flag)'); return 2; }
    if (typeof a.owner === 'string') { out(clearPause({ dir, owner: a.owner }) ? `resumed ${a.owner}` : `no flag for ${a.owner}`); return 0; }
    const l = listPauses({ dir, maxPauseMinutes: s.maxPauseMinutes, now }); l.forEach((x) => clearPause({ dir, owner: x.owner })); out(`resumed ${l.length} owner(s)`); return 0;
  }
  if ('owner' in a) {
    if (!validOwner(a.owner)) { out('error: --owner needs a valid owner name'); return 2; }
    const f = setPause({ dir, owner: a.owner, reason: typeof a.reason === 'string' ? a.reason : 'operator pause', ...(typeof a['resume-when'] === 'string' ? { resumeWhen: a['resume-when'] } : {}), by: 'operator', now });
    out(`paused ${a.owner} since ${f.at} (auto-expires after ${s.maxPauseMinutes} min)`); return 0;
  }
  out('usage: worker-pause --owner=<owner> [--reason=… --resume-when=…] | --resume [--owner=<owner>] | --list | --tick [--owners=a,b]'); return 2;
}
