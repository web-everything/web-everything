/** Declared note planning; the only IO is the separately bound append sink. */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';

/** Collapse whitespace and format a fixed instant using New York's DST rules. */
export function planHandoffNote({ text, at }) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('handoff-note: text must be non-empty');
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(Date.parse(at))) throw new TypeError('handoff-note: at must be ISO');
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
  return { line: `- ${time} ET: ${text.replace(/\s+/g, ' ').trim()}` };
}

export function handoffNoteOperation({ now = () => new Date() } = {}) {
  return op('handoff-note', {
    input: { text: 'string', at: { type: 'string', required: false } }, verdictFrom: 'plan',
    plan: compute({ reads: ['input.text', 'input.at'], fn: ({ input }) => planHandoffNote({ ...input, at: input.at ?? now().toISOString() }) }),
    write: effect({ reads: ['verdict'], effects: ({ verdict }) => [{ type: 'handoff-note.append', idempotent: false, payload: verdict }] }),
  });
}
