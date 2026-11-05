/** Clone-backed launchd processes must have started after the latest adopted rebuild. */
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findStaleCodeServices } from '../../lib/launchd-code-restart.mjs';
import { daemonCloneRoots } from '../../lib/daemon-clone-registry.mjs';
import { workspaceOf } from '../../lib/automation-home.mjs';
import { cloneKey } from '../../lib/daemon-overlays.mjs';

// This registry includes overlay clones without requiring HEAD to be an ancestor of main.
const managedRoots = () => daemonCloneRoots(workspaceOf(resolve(dirname(fileURLToPath(import.meta.url)), '../../..')));
const subject = (root, service) => `clone:${root}:service:${service.label ?? service.plistPath ?? 'unknown'}`;
const covered = key => ({ subject: `coverage:${key}`, breach: false, measure: { coverage: 'known' },
  summary: 'Managed clone inventory is readable and its root is known.', recommendation: 'No inventory repair needed.' });
const unknown = (key, reason) => ({ subject: `coverage:${key}`, breach: true, measure: { reason },
  summary: `Clone coverage unknown: ${reason}`,
  recommendation: 'Inspect the managed-clone registry and self-sync state; existing alerts remain open until service freshness is observed.' });

export default {
  id: 'stale-code-service', scope: 'host', cadence: 'every-tick', probes: ['selfSync'],
  // The engine treats breach:null as clean. Missing subjects instead preserve their episodes;
  // only explicit fresh/not-running observations below emit clean service results.
  missingSubjectsUnknown: true,
  openAfter: 1, closeAfter: 1, severity: 'high', action: 'alert',
  recommendationHint: 'Inspect the LaunchAgent and rebuild state; restart approved stateless samplers onto adopted code.',
  evaluate({ selfSync, cloneLag }, { findStaleCodeServices: findStale = findStaleCodeServices, listCloneRoots = managedRoots } = {}) {
    const rows = [], roots = new Set();
    try {
      const managed = listCloneRoots();
      if (!Array.isArray(managed)) throw new Error('managed clone list unreadable');
      for (const root of [...managed, ...(cloneLag || []).map(c => c.cloneRoot),
        ...(selfSync || []).map(c => c.cloneRoot ?? c.root).filter(root => root !== undefined)]) {
        if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('managed clone root unreadable');
        roots.add(root);
      }
    } catch (error) { return [unknown('managed-clones', String(error.message ?? error))]; }
    const knownKeys = new Set([...roots].map(root => cloneKey(root)));
    if (roots.size && Array.isArray(selfSync)) rows.push(covered('managed-clones'));
    for (const c of selfSync || []) {
      if (c.cloneKey) rows.push(knownKeys.has(c.cloneKey) ? covered(c.cloneKey) : unknown(c.cloneKey, 'self-sync clone has no known root'));
    }
    for (const cloneRoot of roots) {
      const fresh = [];
      let flags;
      try {
        flags = findStale({ cloneRoot, onFreshService: service => fresh.push(service) });
        if (!Array.isArray(flags)) throw new Error('service inspection returned incomplete evidence');
        // Recover the synthetic inspection-failure episode independently of service
        // freshness. Returned unknown evidence still owns that subject and cannot clear it.
        const inspectionSubject = subject(cloneRoot, {});
        if (!flags.some(flag => subject(cloneRoot, flag) === inspectionSubject)) rows.push({
          subject: inspectionSubject, breach: false, measure: { cloneRoot, inspection: 'complete' },
          summary: 'Service inspection completed successfully; individual service results remain authoritative.',
          recommendation: 'No inspection repair needed; address any remaining service alerts.',
        });
      } catch (error) { flags = [{ label: null, reason: 'inspection-failed', error: String(error.message ?? error) }]; fresh.length = 0; }
      if (!flags.length) rows.push({ subject: `clone:${cloneRoot}`, breach: false, measure: { cloneRoot },
        summary: 'No stale clone-backed services detected.', recommendation: 'No restart needed.' });
      rows.push(...flags.map(flag => ({
        subject: subject(cloneRoot, flag), breach: true, measure: { cloneRoot, ...flag },
        summary: `${flag.label ?? flag.plistPath ?? 'LaunchAgent'}: ${flag.reason}`,
        recommendation: flag.reason === 'stale-code'
          ? 'Inspect the LaunchAgent; kickstart -k the approved stateless sampler to load the adopted build.'
          : 'Inspect and repair the unreadable plist, process evidence or rebuild state; freshness cannot be established. Escalate to the operator before restarting.',
      })));
      for (const service of fresh) {
        const clean = { breach: false, measure: { cloneRoot, ...service }, summary: 'Service is fresh or positively not running.', recommendation: 'No restart needed.' };
        rows.push({ ...clean, subject: subject(cloneRoot, service) });
        // A readable fresh plist also clears its earlier label-unknown read-error subject.
        if (service.plistPath) rows.push({ ...clean, subject: subject(cloneRoot, { plistPath: service.plistPath }) });
      }
    }
    return rows;
  },
};
