/** Shared, non-throwing admission over the existing free-scope snapshot and assessor. */
import { assessFreeScope, qualifyFile, partitionRegistry } from './free-scope.mjs';
import { collectFreeScope } from './free-scope-io.mjs';
import { isProseScopeFile } from '../lib/prose-scope-globs.mjs';

export function checkScope({ declaredFiles, excludeAgent, excludeOwner, collect = collectFreeScope, now = Date.now } = {}) {
  try {
    const files = [...new Set((Array.isArray(declaredFiles) ? declaredFiles : declaredFiles.split(','))
      .map(file => qualifyFile(file)).filter(file => file && !isProseScopeFile(file)))];
    if (!files.length) return { ok: true, overlaps: [] };
    const nowMs = typeof now === 'function' ? now() : now;
    const snapshot = collect({ files: files.join(','), now: () => nowMs });
    if (!Array.isArray(snapshot.prs) || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.unreadable)) {
      throw new Error('incomplete scope snapshot');
    }
    for (const entry of snapshot.agents) {
      if (!entry || typeof entry.agent !== 'string' || !entry.agent.trim() || !Array.isArray(entry.files)
        || !entry.files.length || entry.files.some(f => typeof f !== 'string' || !f.trim())
        || !Number.isFinite(Date.parse(entry.startedAt))
        || (entry.ttlHours !== undefined && !(Number.isFinite(entry.ttlHours) && entry.ttlHours > 0))
        || (entry.staleAfterMinutes !== undefined && !(Number.isFinite(entry.staleAfterMinutes) && entry.staleAfterMinutes > 0))
        || (entry.lastSeenAt !== undefined && !Number.isFinite(Date.parse(entry.lastSeenAt)))) {
        throw new Error('corrupt scope registry entry');
      }
    }
    if (snapshot.status === 'unknown') throw new Error('unknown scope snapshot');
    const verdict = assessFreeScope({ ...snapshot, files, nowMs, excludeAgent, excludeOwner });
    const { live } = partitionRegistry(snapshot.agents, nowMs);
    const overlaps = verdict.files.filter(row => row.state === 'occupied').flatMap(row => row.holders.map(holder => {
      if (holder.type === 'pr') return { file: row.file, pr: { number: holder.number, repo: holder.repo } };
      const entry = live.find(e => e.agent === holder.agent);
      return { file: row.file, agent: holder.agent,
        ...(entry?.lane !== undefined ? { lane: entry.lane } : {}), ...(entry?.item !== undefined ? { item: entry.item } : {}) };
    }));
    const unreadable = snapshot.unreadable;
    return { ok: verdict.status === 'free' && !unreadable.length, overlaps,
      ...(!unreadable.length ? {} : { unreadable }),
      ...(verdict.status === 'free' && !unreadable.length ? {} : { reason: verdict.headline }) };
  } catch (error) {
    return { ok: false, overlaps: [], reason: `scope check failed: ${error?.message || String(error)}` };
  }
}
