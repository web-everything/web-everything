/** Conservative stale-registration pruning. Unknown evidence always retains the overlay. */
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cascadePolicy } from '../policy-cascade.mjs';
import { runGhSync } from '../gh-throttle.mjs';
import { readOverlayState, overlayFilePath, removeOverlay, appendOverlayEvent } from '../daemon-overlays.mjs';
import { remoteTip, withAddGuardLock, readPendingDrops, addPending, clearPending, restoreRegistration } from '../overlay-registration.mjs';
import { defaultPrState } from './edge-fetch.mjs';

const SETTINGS = join(dirname(fileURLToPath(import.meta.url)), '../daemon-rebuild-settings.json');
let lastSetting;
export function resolveOverlayPrune(env = process.env, { settingsPath = SETTINGS } = {}) {
  let tool;
  try { tool = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).overlayPrune; } catch { /* standard */ }
  const r = cascadePolicy('overlayPrune', tool, { env, standard: { enabled: true },
    envValues: { enabled: env.WE_OVERLAY_PRUNE === '0' ? false : env.WE_OVERLAY_PRUNE === '1' ? true : undefined },
    valid: { enabled: v => typeof v === 'boolean' } });
  const line = `overlayPrune=${r.value.enabled} source=${r.sources.enabled}`;
  if (lastSetting !== line) { console.error(line); lastSetting = line; }
  return r.value;
}

export function planOverlayPrune({ overlays, mainSha, prState, openPrHeads, tipOf, isAncestor, conflictsWithMain, conflictCounts = {} }) {
  const heads = openPrHeads(); // null means discovery failed: rules b/c have no proof.
  const states = new Map([...new Set(overlays.filter(o => o.pr > 0).map(o => o.pr))].map(pr => [pr, prState(pr)]));
  const live = o => states.get(o.pr) === 'OPEN' || heads?.some(p => p.ref === o.ref || (o.pr > 0 && p.number === o.pr));
  const tips = new Map(overlays.map(o => [o.ref, tipOf(o.ref)]));
  const supersedes = (other, o) => {
    const tip = tips.get(o.ref), next = tips.get(other.ref);
    if (other.ref === o.ref || !tip || !next) return false;
    if (tip === next) return live(other) || other.ref < o.ref;
    return isAncestor(tip, next) === true;
  };
  const planned = [];
  for (const o of overlays) {
    const state = states.get(o.pr), tip = tips.get(o.ref);
    if (o.pinned === true || !tip || live(o) || state === 'OPEN') continue;
    // A numbered registration with unknown state cannot be retired by ancestry either.
    if (o.pr > 0 && !['CLOSED', 'MERGED'].includes(state)) continue;
    const evidence = { ref: o.ref, pr: o.pr ?? null, tip, mainSha };
    if (state === 'CLOSED' || state === 'MERGED') {
      planned.push({ ...evidence, reason: state === 'CLOSED' ? 'pr-closed' : 'pr-merged', prState: state });
      continue;
    }
    if (!heads || !tip) continue;
    const successor = overlays.find(other => supersedes(other, o));
    if (successor) {
      planned.push({ ...evidence, reason: 'superseded', supersededBy: successor.ref,
        supersedingTip: tips.get(successor.ref) });
    } else if (!(o.pr > 0) && mainSha && conflictsWithMain(o.ref) === true && conflictCounts[o.ref] > 2) {
      planned.push({ ...evidence, reason: 'pr0-conflicting', conflictCount: conflictCounts[o.ref] });
    }
  }
  // Supersession must end at retained work, never at another candidate for removal.
  // Re-anchor chains directly to a survivor; without one, conservatively keep the ancestor.
  const removing = new Set(planned.map(o => o.ref));
  const survivors = overlays.filter(o => !removing.has(o.ref));
  return planned.flatMap(item => {
    if (item.reason !== 'superseded') return [item];
    const successor = survivors.find(other => supersedes(other, item));
    return successor ? [{ ...item, supersededBy: successor.ref,
      supersedingTip: tips.get(successor.ref) }] : [];
  });
}

/** Synchronous so both rebuild preparation and the sync kicker finish pruning before reading registrations.
 * countConflicts=false is used by main-sync: only rebuilds advance the consecutive-rebuild clock.
 * Sidecar size is bounded by the current registration set; corrupt state requires operator repair.
 */
export function pruneOverlays({ root, env = process.env, dryRun = false, deps = {} }) {
  const alert = message => {
    try { (deps.alert ?? (m => console.error(`overlay-prune alert: ${m}; inspect registrations and retry`)))(String(message).replace(/[\p{Cc}\p{Cf}]/gu, '')); } catch { /* best effort */ }
  };
  try {
    if (!(deps.resolveSetting ?? resolveOverlayPrune)(env).enabled) return [];
    const io = deps.io ?? fs, file = `${overlayFilePath(root, env)}.prune-state`;
    const execute = () => {
      if (readPendingDrops(root, env).length) throw new Error('pending drops require recovery; run recover-drops');
      const state = (deps.readOverlayState ?? readOverlayState)(root, { env });
      if (state.corrupt) throw new Error('corrupt overlay registrations');
      const overlays = state.overlays;
      // At most 101 GitHub reads per invocation, including the single open-PR inventory.
      if (overlays.length > 100) throw new Error('overlay prune limit 100 exceeded; inspect registrations manually');
      if (!overlays.length) {
        if (!dryRun) io.rmSync(file, { force: true });
        return [];
      }
      const git = deps.git ?? (args => spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }));
      const currentTip = deps.remoteTip ?? deps.tipOf ?? (ref => remoteTip({ root, ref, env, run: (cmd, args) => git(args) }));
      const mainSha = deps.mainSha ?? currentTip('main');
      const tips = new Map(overlays.map(o => [o.ref, currentTip(o.ref)]));
      const tipOf = ref => tips.get(ref);
      let heads = null;
      try {
        heads = deps.openPrHeads ? deps.openPrHeads() : JSON.parse(runGhSync(
          ['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,headRefName,headRefOid'],
          { cwd: root, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }))
          .map(p => ({ number: p.number, ref: p.headRefName, headSha: p.headRefOid }));
        if (!Array.isArray(heads) || heads.length >= 1000 || heads.some(p => !Number.isInteger(p.number) || typeof p.ref !== 'string' || !/^[a-f0-9]{40}$/.test(p.headSha))) {
          throw new Error('incomplete open PR inventory (limit 1000); inspect registrations manually');
        }
      } catch (e) { heads = null; alert(e.message); }
      const conflicts = new Map();
      const conflictsWithMain = ref => {
        if (!conflicts.has(ref)) {
          const tip = tipOf(ref);
          const r = deps.conflictsWithMain ? deps.conflictsWithMain(ref) : (mainSha && tip ? git(['merge-tree', '--write-tree', mainSha, tip]) : null);
          conflicts.set(ref, typeof r === 'boolean' ? r : r && !r.error && /^[a-f0-9]{40}$/.test(r.stdout?.split(/\r?\n/)[0])
            ? r.status === 1 ? true : r.status === 0 ? false : null : null);
        }
        return conflicts.get(ref);
      };
      let previous = {};
      try {
        previous = JSON.parse(io.readFileSync(file, 'utf8'));
        if (!previous || typeof previous !== 'object' || Array.isArray(previous) || Object.values(previous).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('invalid prune counters');
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const counts = Object.create(null);
      for (const o of overlays) {
        counts[o.ref] = heads && !(o.pr > 0) && !heads.some(p => p.ref === o.ref) && conflictsWithMain(o.ref) === true
          ? Math.min(3, (Object.hasOwn(previous, o.ref) ? previous[o.ref] : 0) + (!dryRun && deps.countConflicts !== false ? 1 : 0)) : 0;
      }
      const planned = planOverlayPrune({ overlays, mainSha, prState: deps.prState ?? (pr => defaultPrState({ pr, root })),
        openPrHeads: () => heads, tipOf, conflictsWithMain, conflictCounts: counts,
        isAncestor: deps.isAncestor ?? ((a, b) => { const r = git(['merge-base', '--is-ancestor', a, b]); return !r.error && r.status === 0; }) });
      if (dryRun) return planned;
      const removed = [];
      for (const item of planned) {
        const entry = overlays.find(o => o.ref === item.ref);
        if (entry.pinned === true) continue;
        const adopted = deps.adopted?.find(o => o.ref === item.ref);
        if (adopted && item.reason === 'superseded' && (!adopted.sha ||
          (adopted.sha !== item.supersedingTip && !(deps.isAncestor ?? ((a, b) => git(['merge-base', '--is-ancestor', a, b]).status === 0))(adopted.sha, item.supersedingTip)))) continue;
        if (adopted) Object.assign(item, { wasAdopted: true, adoptedTip: adopted.sha });
        const carrier = item.reason === 'superseded' ? { newRef: item.supersededBy, newTip: item.supersedingTip } : {};
        const carrierHeld = () => !carrier.newRef || currentTip(carrier.newRef) === carrier.newTip;
        addPending(root, env, { kind: 'prune', ref: item.ref, entry, tip: item.tip, event: item, ...carrier, at: new Date().toISOString() });
        if (!carrierHeld() || currentTip(item.ref) !== item.tip) { clearPending(root, env, item.ref); continue; }
        const result = (deps.removeOverlay ?? removeOverlay)(root, item.ref, { env, why: item.reason, expectedOverlay: overlays.find(o => o.ref === item.ref) });
        if (!result.removed) { clearPending(root, env, item.ref); continue; }
        deps.afterDrop?.(item);
        let after, carrierAfter = false;
        try { after = currentTip(item.ref); carrierAfter = carrierHeld(); } catch { /* unreadable requires restore */ }
        if (after !== item.tip || !carrierAfter) {
          (deps.restoreRegistration ?? restoreRegistration)(root, entry, env);
          clearPending(root, env, item.ref);
          alert(`tip changed or unreadable for ${item.ref}; registration restored`);
          continue;
        }
        clearPending(root, env, item.ref);
        delete counts[item.ref];
        removed.push(item);
        (deps.appendOverlayEvent ?? appendOverlayEvent)(root, { kind: 'overlay-pruned', ...item }, { env });
        if (item.wasAdopted) deps.alertAdopted?.(item);
      }
      const temp = `${file}.${randomUUID()}.tmp`;
      try { io.writeFileSync(temp, JSON.stringify(counts)); io.renameSync(temp, file); }
      finally { io.rmSync(temp, { force: true }); }
      return removed;
    };
    if (dryRun && io.existsSync(`${overlayFilePath(root, env)}.add-guard.lock`)) throw new Error('add guard busy; retry');
    return dryRun ? execute() : withAddGuardLock(root, env, execute, { noWait: true });
  } catch (e) { alert(e.message); return []; }
}
