/** Conservative stale-registration pruning. Unknown evidence always retains the overlay. */
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cascadePolicy } from '../policy-cascade.mjs';
import { runGhSync } from '../gh-throttle.mjs';
import { readOverlayState, overlayFilePath, removeOverlay, appendOverlayEvent, registrationIdentity } from '../daemon-overlays.mjs';
import { remoteTip, withAddGuardLock, readPendingDrops, addPending, clearPending, restoreRegistration } from '../overlay-registration.mjs';
import { feedPath, publishAttention } from '../../operations/needs-you-feed.mjs';
import { defaultPrState } from './edge-fetch.mjs';
import { pinnedStatus } from './plan.mjs';
import { readRebuildState } from './state.mjs';
import { REBUILD_IDENTITY_ENV, verifyRev } from './shared.mjs';

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

export function planOverlayPrune({ overlays, mainSha, prState, openPrHeads, tipOf, isAncestor, conflictsWithMain,
  conflictCounts = {}, quarantinedRefs = new Set(), pinStatus = () => null, adoptedHead = null, adoptedOverlays = [] }) {
  const heads = openPrHeads(); // null means discovery failed: rules b/c have no proof.
  const unregisteredHeads = heads?.filter(p => !overlays.some(o => o.ref === p.ref || (o.pr > 0 && o.pr === p.number)));
  const states = new Map([...new Set(overlays.filter(o => o.pr > 0).map(o => o.pr))].map(pr => [pr, prState(pr)]));
  const live = o => states.get(o.pr) === 'OPEN' || heads?.some(p => p.ref === o.ref || (o.pr > 0 && p.number === o.pr));
  const tips = new Map(overlays.map(o => [o.ref, tipOf(o.ref)]));
  const supersedes = (other, o) => {
    const tip = tips.get(o.ref), next = tips.get(other.ref);
    if (other.ref === o.ref || !tip || !next || conflictsWithMain(other.ref) !== false) return false;
    if (tip === next) return live(other) || other.ref < o.ref;
    return probe(tip, next) === true;
  };
  const ancestry = new Map();
  const probe = (a, b) => {
    const key = `${a}:${b}`;
    if (!ancestry.has(key)) ancestry.set(key, a && b ? isAncestor(a, b) : null);
    return ancestry.get(key);
  };
  const planned = [];
  for (const o of overlays) {
    const state = states.get(o.pr), tip = tips.get(o.ref);
    if (o.pinned === true || !tip || live(o) || state === 'OPEN') continue;
    const pin = pinStatus(o, tip);
    if (pin?.pinned !== false || pin.why !== null) continue;
    // A numbered registration with unknown state cannot be retired by ancestry either.
    if (o.pr > 0 && !['CLOSED', 'MERGED'].includes(state)) continue;
    // Unknown containment against any possible carrier blocks every retirement rule.
    const carriers = [...overlays.filter(other => other.ref !== o.ref).map(other => tips.get(other.ref)),
      ...(heads ?? []).map(p => p.headSha)];
    if (carriers.some(sha => { const result = probe(tip, sha); return result !== true && result !== false; })) continue;
    if (state !== 'MERGED' && (adoptedOverlays === null || adoptedOverlays.some(entry => entry.ref === o.ref))) continue;
    // The running build carries this tip; let established-overlay hold/auto-rebase handle it.
    // Only a merged PR proves that retiring it cannot discard live content.
    if (state !== 'MERGED' && adoptedHead && probe(tip, adoptedHead) !== false) continue;
    const evidence = { ref: o.ref, pr: o.pr ?? null, tip, mainSha };
    if (state === 'CLOSED' || state === 'MERGED') {
      planned.push({ ...evidence, reason: state === 'CLOSED' ? 'pr-closed' : 'pr-merged', prState: state });
      continue;
    }
    if (!heads || !tip) continue;
    if (unregisteredHeads.some(p => p.headSha === tip || probe(tip, p.headSha) === true)) continue;
    // Resolution commits may live on an edge rather than the ordinary overlay tip.
    if (o.edgeResolution || o.conflictOverride) continue;
    const successor = overlays.find(other => supersedes(other, o));
    if (successor) {
      planned.push({ ...evidence, reason: 'superseded', supersededBy: successor.ref,
        supersedingTip: tips.get(successor.ref) });
    } else if (!(o.pr > 0) && mainSha && (quarantinedRefs.has(o.ref)
      || (conflictsWithMain(o.ref) === true && conflictCounts[o.ref] > 2))) {
      planned.push({ ...evidence, action: 'quarantine', reason: 'pr0-conflicting', conflictCount: conflictCounts[o.ref] });
    }
  }
  // Supersession must end at retained work, never at another candidate for removal.
  // Re-anchor chains directly to a survivor; without one, conservatively keep the ancestor.
  const removing = new Set(planned.map(o => o.ref));
  const survivors = overlays.filter(o => !removing.has(o.ref));
  return planned.flatMap(item => {
    if (item.reason !== 'superseded') return [{ action: 'prune', ...item }];
    const successor = survivors.find(other => supersedes(other, item));
    return successor ? [{ action: 'prune', ...item, supersededBy: successor.ref,
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
    const quarantineFile = `${overlayFilePath(root, env)}.quarantine`;
    const persist = (path, value) => {
      const temp = `${path}.${randomUUID()}.tmp`;
      try { io.writeFileSync(temp, JSON.stringify(value)); io.renameSync(temp, path); }
      finally { io.rmSync(temp, { force: true }); }
    };
    const execute = () => {
      if (readPendingDrops(root, env).length) throw new Error('pending drops require recovery; run recover-drops');
      const state = (deps.readOverlayState ?? readOverlayState)(root, { env });
      if (state.corrupt) throw new Error('corrupt overlay registrations');
      const overlays = state.overlays;
      // At most 101 GitHub reads per invocation, including the single open-PR inventory.
      if (overlays.length > 100) throw new Error('overlay prune limit 100 exceeded; inspect registrations manually');
      const git = deps.git ?? (args => spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }));
      const currentTip = deps.remoteTip ?? deps.tipOf ?? (ref => remoteTip({ root, ref, env, run: (cmd, args) => git(args) }));
      const mainSha = deps.mainSha ?? currentTip('main');
      const tips = new Map(overlays.map(o => [o.ref, currentTip(o.ref)]));
      const tipOf = ref => tips.get(ref);
      const adoptedState = readRebuildState(root, env).adopted;
      const runningHead = verifyRev(git, 'HEAD');
      const adoptedHead = Object.hasOwn(deps, 'adoptedHead') ? deps.adoptedHead
        : adoptedState?.head && adoptedState.head === runningHead ? adoptedState.head : null;
      const historyHead = adoptedHead ?? runningHead;
      let adoptedOverlays = deps.adopted ?? [];
      if (historyHead) {
        const log = git(['log', '--first-parent', '--format=%P%x09%ce%x09%s', historyHead, '--not', mainSha]);
        if (log.error || log.status !== 0) adoptedOverlays = null;
        else {
          adoptedOverlays = [...adoptedOverlays, ...(adoptedState?.head === historyHead ? adoptedState.applied ?? [] : [])];
          for (const line of String(log.stdout ?? '').split('\n')) {
            const [parents, committer, ...subject] = line.split('\t');
            const hit = subject.join('\t').match(/^daemon-rebuild: merge overlay (\S+) /);
            const ps = parents.split(' ');
            if (hit && committer === REBUILD_IDENTITY_ENV.GIT_COMMITTER_EMAIL && [2, 3].includes(ps.length)) {
              adoptedOverlays.push({ ref: hit[1], sha: ps[1] });
            }
          }
        }
      }
      const isAncestor = deps.isAncestor ?? ((a, b) => {
        const r = git(['merge-base', '--is-ancestor', a, b]);
        return !r.error && r.status === 0 ? true : !r.error && r.status === 1 ? false : null;
      });
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
        if (!previous || typeof previous !== 'object' || Array.isArray(previous) || Object.values(previous).some(n => !(Number.isSafeInteger(n) && n >= 0) && (!n || !Number.isSafeInteger(n.count) || n.count < 0 || typeof n.tip !== 'string' || !n.identity || typeof n.identity !== 'object' || Array.isArray(n.identity)))) throw new Error('invalid prune counters');
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      let quarantines = [];
      try {
        quarantines = JSON.parse(io.readFileSync(quarantineFile, 'utf8'));
        if (!Array.isArray(quarantines) || quarantines.length > 100 || quarantines.some(q =>
          !q || typeof q.ref !== 'string' || !/^[a-f0-9]{40}$/.test(q.tip) || !q.identity
          || typeof q.identity !== 'object' || Array.isArray(q.identity)
          || typeof q.since !== 'string' || !Number.isSafeInteger(q.count) || q.count < 3)) {
          throw new Error('invalid overlay quarantine; inspect registrations manually');
        }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const lifted = quarantines.filter(q => {
        const entry = overlays.find(o => o.ref === q.ref);
        return !entry || (tipOf(q.ref) && tipOf(q.ref) !== q.tip)
          || !isDeepStrictEqual(q.identity, registrationIdentity(entry)) || conflictsWithMain(q.ref) === false;
      });
      quarantines = quarantines.filter(q => !lifted.includes(q));
      const counts = Object.create(null), records = Object.create(null);
      for (const o of overlays) {
        const hasPrior = Object.hasOwn(previous, o.ref);
        const prior = hasPrior ? previous[o.ref] : undefined;
        const identity = registrationIdentity(o), tip = tipOf(o.ref);
        const same = prior && prior.tip === tip && isDeepStrictEqual(prior.identity, identity);
        const eligible = heads && tip && !(o.pr > 0) && !heads.some(p => p.ref === o.ref) && conflictsWithMain(o.ref) === true;
        counts[o.ref] = eligible && (!hasPrior || same)
          ? Math.min(3, (same ? prior.count : 0) + (!dryRun && deps.countConflicts !== false ? 1 : 0)) : 0;
        records[o.ref] = { tip: tip ?? '', identity, count: counts[o.ref] };
      }
      // Unknown conflict evidence cannot lift an existing quarantine. Preserve its
      // skip while keeping the original consecutive-conflict counter unchanged.
      const quarantineCounts = { ...counts };
      for (const q of quarantines) quarantineCounts[q.ref] = q.count;
      const planned = planOverlayPrune({ overlays, mainSha, prState: deps.prState ?? (pr => defaultPrState({ pr, root })),
        openPrHeads: () => heads, tipOf, conflictsWithMain, conflictCounts: quarantineCounts, quarantinedRefs: new Set(quarantines.map(q => q.ref)),
        pinStatus: (entry, tip) => mainSha ? pinnedStatus(git, entry, mainSha, tip) : null,
        adoptedHead, adoptedOverlays, isAncestor });
      if (dryRun) return planned;
      if (lifted.length) {
        if (quarantines.length) persist(quarantineFile, quarantines);
        else io.rmSync(quarantineFile, { force: true });
        for (const q of lifted) (deps.appendOverlayEvent ?? appendOverlayEvent)(root,
          { kind: 'overlay-quarantine-lifted', ...q }, { env });
      }
      const completed = [];
      for (const item of planned) {
        const entry = overlays.find(o => o.ref === item.ref);
        if (entry.pinned === true) continue;
        if (item.action === 'quarantine') {
          if (currentTip(item.ref) !== item.tip) continue;
          if (!quarantines.some(q => q.ref === item.ref)) {
            const record = { ref: item.ref, tip: item.tip, identity: registrationIdentity(entry),
              since: new Date().toISOString(), count: item.conflictCount };
            quarantines.push(record);
            persist(quarantineFile, quarantines);
            (deps.appendOverlayEvent ?? appendOverlayEvent)(root, { kind: 'overlay-quarantined', ...record }, { env });
            try {
              (deps.publishAttention ?? publishAttention)({ repo: 'web-everything', pr: 0,
                head: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
                ref: item.ref, kind: 'overlay-quarantined', title: `Overlay ${item.ref} quarantined`,
                reason: 'Repeated conflicts with main; rebase the branch to resume application' }, { path: feedPath({ env }) });
            } catch (e) { alert(`quarantine attention publication failed: ${e.message}`); }
          }
          completed.push(item);
          continue;
        }
        const adopted = adoptedOverlays?.find(o => o.ref === item.ref);
        if (adopted) Object.assign(item, { wasAdopted: true, adoptedTip: adopted.sha });
        const carrier = item.reason === 'superseded' ? { newRef: item.supersededBy, newTip: item.supersedingTip } : {};
        const carrierHeld = () => !carrier.newRef || currentTip(carrier.newRef) === carrier.newTip;
        addPending(root, env, { kind: 'prune', ref: item.ref, entry, tip: item.tip, event: item, ...carrier, at: new Date().toISOString() });
        if (!carrierHeld() || currentTip(item.ref) !== item.tip) { clearPending(root, env, item.ref); continue; }
        const result = (deps.removeOverlay ?? removeOverlay)(root, item.ref, { env, why: item.reason, expectedOverlay: entry,
          ...(carrier.newRef ? { requireRef: carrier.newRef, expectedRequiredOverlay: overlays.find(o => o.ref === carrier.newRef) } : {}) });
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
        delete records[item.ref];
        completed.push(item);
        (deps.appendOverlayEvent ?? appendOverlayEvent)(root, { kind: 'overlay-pruned', ...item }, { env });
        if (item.wasAdopted) deps.alertAdopted?.(item);
      }
      if (overlays.length) persist(file, records);
      else io.rmSync(file, { force: true });
      return completed;
    };
    if (dryRun && io.existsSync(`${overlayFilePath(root, env)}.add-guard.lock`)) throw new Error('add guard busy; retry');
    return dryRun ? execute() : withAddGuardLock(root, env, execute, { noWait: true });
  } catch (e) { alert(e.message); return []; }
}
