/** unaudited-tip — fail closed to the adopted head when audit evidence is unavailable. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveOverlayFollowTip } from '../daemon-overlays.mjs';

export function makeAuditedTipGate(env = process.env) {
  if (resolveOverlayFollowTip(env) === 'follow') return null;
  let records;
  return (ref, sha) => {
    // Snapshot lazily, once per gate, so every decision in a plan sees the same evidence.
    if (records === undefined) {
      records = [];
      try {
        const path = env.WE_FIX_READY_PATH || JSON.parse(readFileSync(
          new URL('../../settings/prototype-load.json', import.meta.url), 'utf8',
        )).readyRecordPath;
        const expanded = path === '~' ? homedir() : path.replace(/^~\//, `${homedir()}/`);
        for (const line of readFileSync(expanded, 'utf8').split('\n')) {
          try { records.push(JSON.parse(line)); } catch { /* Bad JSONL lines supply no evidence. */ }
        }
      } catch { /* unaudited-tip: unreadable evidence never authorizes a moving tip. */ }
    }
    return typeof sha === 'string' && records.some((r) => r?.ref === ref
      && typeof r.sha === 'string' && r.sha.toLowerCase() === sha.toLowerCase()
      && r.tests === 'green'
      && (typeof r.audit === 'string' && /^NOT WEAKENED$/i.test(r.audit)
        || r.audit === 'WEAKENED' && typeof r.auditRuling === 'string' && r.auditRuling.trim().length > 0));
  };
}
