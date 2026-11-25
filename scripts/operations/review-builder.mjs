import { parseDelegationMarker } from '../lib/delegation-marker.mjs';

/** Builder family from the delegation marker, then the reviewed commit trailer; otherwise unknown. PURE. */
export function resolveBuilder({ body = '', headMessage = '' } = {}) {
  const d = parseDelegationMarker(String(body ?? ''));
  if (d) return { provider: d.provider, model: d.model, taskType: d.taskType, delegated: true, source: 'delegation-marker' };
  const m = String(headMessage ?? '').match(/^Co-Authored-By:\s*Claude\s+([^<\n]+?)\s*</im);
  if (m) {
    const model = `claude-${m[1].replace(/\([^)]*\)/g, '').trim().toLowerCase().replace(/\s+/g, '-')}`;
    return { provider: 'claude', model, taskType: null, delegated: false, source: 'co-authored-by' };
  }
  return { provider: 'unknown', model: 'unknown', taskType: null, delegated: false, source: 'none' };
}
