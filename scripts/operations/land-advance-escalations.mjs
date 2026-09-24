/**
 * @file land-advance-escalations.mjs
 * L0 script action -> L1 cheap hiccup classifier -> L2 packet handed to AI triage
 * -> L3 operator. This slice never launches triage. Stable IDs update one packet,
 * preserving its creation date and operator resolution; plan mode only builds.
 * The classifier is a pure text function and its observation is recorded, not acted on.
 */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { classifyAgentReturn } from '../conveyor/hiccup-classify.mjs';
export function buildEscalationPacket(row, now, existing) {
  const classified = classifyAgentReturn({ text: row.evidence.join('\n'), num: row.pr });
  return { id: row.packetId, kind: row.kind, target: row.subject, createdAt: existing?.createdAt ?? new Date(now).toISOString(),
    evidence: [...row.evidence], tried: [`L0 assessed available evidence; ${row.verdict ?? 'drain still waiting'}`, `L1 hiccup-classify: ${JSON.stringify(classified)}`],
    question: row.blockedBy ? `What must unblock ${row.blockedBy} so ${row.subject} can land?` : `What should resolve ${row.kind} for ${row.subject}?`,
    ladder: { next: 'L2 ai-triage' }, status: existing?.status ?? 'open',
    ...(existing?.resolvedAt ? { resolvedAt: existing.resolvedAt, resolution: existing.resolution } : {}) };
}
export function writeEscalationPacket(packet, { dir, fs: io = fs } = {}) {
  if (!/^[\w-]+$/.test(packet.id)) throw new TypeError('Unsafe escalation id');
  io.mkdirSync(dir, { recursive: true });
  const path = join(dir, `${packet.id}.json`), tmp = `${path}.tmp`;
  io.writeFileSync(tmp, JSON.stringify(packet, null, 2) + '\n'); io.renameSync(tmp, path);
  return path;
}
export function listEscalations({ dir, fs: io = fs } = {}) {
  let names;
  try { names = io.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter((n) => n.endsWith('.json')).sort().map((n) => JSON.parse(io.readFileSync(join(dir, n), 'utf8')));
}
export function listUnresolvedEscalations(options) { return listEscalations(options).filter((p) => p.status === 'open'); }
export function renderEscalationsSection(list) {
  return ['Escalations', ...list.filter((p) => p.status === 'open').map((p) => `- ${p.target}: ${p.question} (${p.ladder.next}; ${p.id})`)].join('\n');
}
