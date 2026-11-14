/** unaudited-tip — fail closed to the adopted head when audit evidence is unavailable. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveOverlayFollowTip } from '../daemon-overlays.mjs';
import { readPlatformPreferences } from '../policy-cascade.mjs';
import { mergeRuledWeakened, readyEvidence } from '../../operations/prototype-load.mjs';

const TOOL_SETTINGS = new URL('../../settings/prototype-load.json', import.meta.url);

export function makeAuditedTipGate(env = process.env) {
  if (resolveOverlayFollowTip(env) === 'follow') return null;
  let snapshot;
  return (ref, sha) => {
    // Snapshot lazily, once per gate, so every decision in a plan sees the same evidence.
    if (snapshot === undefined) {
      snapshot = { records: [], ruledWeakened: [] };
      try {
        let tool = {};
        try { tool = JSON.parse(readFileSync(TOOL_SETTINGS, 'utf8')); } catch { /* an explicit env path still works */ }
        const path = env.WE_FIX_READY_PATH || tool.readyRecordPath;
        const expanded = path === '~' ? homedir() : path.replace(/^~\//, `${homedir()}/`);
        for (const line of readFileSync(expanded, 'utf8').split('\n')) {
          try { snapshot.records.push(JSON.parse(line)); } catch { /* Bad JSONL lines supply no evidence. */ }
        }
        // The operator allowlist is the same union prototype-load uses; a WEAKENED record is only ever evidence
        // when an entry binds its exact ref, sha, ruling and disclosed findings.
        const platform = readPlatformPreferences({ env, warn: () => {} });
        snapshot.ruledWeakened = mergeRuledWeakened(platform.prefs.prototypeLoad?.ruledWeakened, tool.ruledWeakened);
      } catch { /* unaudited-tip: unreadable evidence never authorizes a moving tip. */ }
    }
    // The canonical admission judge decides (latest record for the exact ref+sha wins; a red or unruled-WEAKENED
    // record never authorizes). No fingerprint source is passed, so only a record naming this exact sha counts.
    return typeof ref === 'string' && typeof sha === 'string'
      && readyEvidence(snapshot.records, { branch: ref, sha }, snapshot.ruledWeakened, null) !== null;
  };
}
