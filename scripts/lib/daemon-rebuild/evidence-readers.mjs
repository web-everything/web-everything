/** One policy for all evidence reads made by an early/recovery rebuild child.
 * Legacy entry points consult the async scope too, so adding an indirect caller cannot
 * silently downgrade the child. No scope is installed for tick-start compatibility.
 */
import { readFileSync } from 'node:fs';
import { readRebuildStateStrict, readReadyCandidateStrict } from './state.mjs';
import { readPendingAdoptionsStrict } from '../overlay-adoption.mjs';
import { overlayFilePath } from '../daemon-overlays.mjs';
import { starvePath } from './lease.mjs';
import { requestPath, watchPath } from '../daemon-force-adopt.mjs';
import { pendingPath } from '../overlay-drop-pending.mjs';
import { daemonStateDir } from '../daemon-last-good.mjs';
import { join } from 'node:path';

export class RebuildEvidenceError extends Error {
  constructor(cause) { super('state-unreadable: repair persisted rebuild evidence before retrying', { cause }); }
}
export function createRebuildReaders({ strict = false, read = readFileSync } = {}) {
  if (!strict) return undefined;
  const checked = fn => (...args) => {
    try { return fn(...args); } catch (cause) { throw new RebuildEvidenceError(cause); }
  };
  const json = (file, absent) => {
    let text;
    try { text = read(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return absent; throw e; }
    return JSON.parse(text);
  };
  const object = r => r !== null && typeof r === 'object' && !Array.isArray(r);
  const text = r => typeof r === 'string' && r.length > 0;
  const date = r => text(r) && Number.isFinite(Date.parse(r));
  const readers = {
    forceRequest: checked((root, env) => {
      const r = json(requestPath(root, env), undefined);
      if (r !== undefined && (!object(r) || !['daemon', 'ruling', 'quote', 'sha'].every(k => text(r[k]))
        || !date(r.requestedAt) || !date(r.expiresAt))) throw new Error('Invalid force request');
      return r ?? null;
    }),
    forceWatch: checked((root, env) => {
      const r = json(watchPath(root, env), undefined);
      if (r !== undefined && (!object(r) || !['daemon', 'ruling', 'sha'].every(k => text(r[k]))
        || !date(r.startedAt) || !Number.isSafeInteger(r.ticksLeft) || r.ticksLeft < 0
        || !Number.isSafeInteger(r.bad) || r.bad < 0 || !(r.lastGood === null || object(r.lastGood)))) {
        throw new Error('Invalid force watch');
      }
      return r ?? null;
    }),
    conflictWakes: checked((_root, env) => {
      const r = json(join(daemonStateDir(env), 'overlay-conflict-wake.json'), {});
      if (!object(r) || !Object.values(r).every(v => object(v) && Number.isSafeInteger(v.pr) && v.pr > 0
        && text(v.ref) && date(v.at))) throw new Error('Invalid overlay conflict wakes');
      return r;
    }),
    pendingDrops: checked((root, env) => {
      const r = json(pendingPath(root, env), { pending: [] });
      if (!object(r) || !Array.isArray(r.pending)) throw new Error('Invalid pending drops');
      return r.pending;
    }),
    state: checked((root, env) => readRebuildStateStrict(root, env, read)),
    ready: checked((root, env) => readReadyCandidateStrict(root, env, read)),
    pending: checked((root, env) => readPendingAdoptionsStrict(root, { env, fs: { readFileSync: read } })),
    // The build lease is part of the strictly validated rebuild state, never a separate fallback.
    lease: checked((root, env) => readRebuildStateStrict(root, env, read).building),
    overlays: checked((root, env) => {
      const r = json(overlayFilePath(root, env), { clone: null, overlays: [] });
      if (!r || Array.isArray(r) || !Array.isArray(r.overlays)
        || !(r.clone === null || typeof r.clone === 'string')
        || !r.overlays.every(o => object(o) && text(o.ref)
          && (o.pr === null || (Number.isSafeInteger(o.pr) && o.pr > 0)) && date(o.addedAt)
          && (o.addedBy === null || text(o.addedBy)) && (o.reason === null || typeof o.reason === 'string')
          && (!('pinned' in o) || typeof o.pinned === 'boolean')
          && (!('stackBases' in o) || (Array.isArray(o.stackBases) && o.stackBases.every(text)))
          && (!('conflictOverride' in o) || (object(o.conflictOverride) && text(o.conflictOverride.instruction)
            && text(o.conflictOverride.actor) && date(o.conflictOverride.at))))) {
        throw new Error('Invalid overlay registry');
      }
      return { ...r, corrupt: false };
    }),
    overlayEvents: checked((root, env) => {
      let text;
      try { text = read(overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl'), 'utf8'); }
      catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      return text.split('\n').filter(line => line.trim()).map(line => {
        const r = JSON.parse(line);
        if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.ref !== 'string' || typeof r.kind !== 'string') {
          throw new Error('Invalid overlay event');
        }
        return r;
      });
    }),
    starvation: checked((root, env) => {
      const r = json(starvePath(root, env), { count: 0 });
      if (!r || !Number.isSafeInteger(r.count) || r.count < 0) throw new Error('Invalid starvation evidence');
      return r.count;
    }),
  };
  readers.validate = (root, env) => {
    readers.state(root, env); readers.ready(root, env); readers.pending(root, env);
    readers.overlays(root, env); readers.starvation(root, env); readers.overlayEvents(root, env);
    readers.forceRequest(root, env); readers.forceWatch(root, env); readers.conflictWakes(root, env); readers.pendingDrops(root, env);
  };
  return Object.freeze(readers);
}
