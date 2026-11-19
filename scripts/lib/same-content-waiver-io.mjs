/** Waiver carry effects are best effort; the history proof itself always fails closed. */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { notifyDesktopChecked } from '../conveyor/branch-sync.mjs';
import { classifyHeadMove } from './same-content-carry.mjs';

export function createSameContentProof({ repo, exec, env = process.env } = {}) {
  const memo = new Map();
  return (from, to) => {
    const key = `${from}:${to}`;
    if (!memo.has(key)) memo.set(key, classifyHeadMove({ repo, exec, env, from, to }));
    return memo.get(key);
  };
}
export function recordWaiverCarry({ ref, from, to, ruling, matched, commits }, {
  env = process.env, path = join(resolveCoordinationRoot({ env }), 'same-content-carry.jsonl'),
  append = appendFileSync, mkdir = mkdirSync, notify = notifyDesktopChecked, now = () => new Date(),
} = {}) {
  const record = { at: new Date(now()).toISOString(), ref, from, to, ruling, matched, commits };
  try { mkdir(dirname(path), { recursive: true }); append(path, `${JSON.stringify(record)}\n`, 'utf8'); } catch { /* observability never blocks admission */ }
  try { notify({ title: 'Waiver carried to same content', body: `${ref}: ${from} → ${to} (${ruling}); ${commits.map(c => c.kind).join(', ')}`.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ') }); } catch { /* best effort */ }
}
