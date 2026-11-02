import { readFileSync } from 'node:fs';

function readHeapCapSettings() {
  try {
    return JSON.parse(readFileSync(new URL('../settings/node-heap-cap.json', import.meta.url), 'utf8'));
  } catch { return null; }
}

/** Node flags for a named review child; missing or unreadable settings leave it uncapped. */
export function heapCapArgs(name, { settings = readHeapCapSettings() } = {}) {
  const cap = Object.hasOwn(settings?.caps ?? {}, name) ? settings.caps[name] : undefined;
  const floor = settings?.floorMb;
  if (!Number.isSafeInteger(cap) || cap <= 0 || !Number.isSafeInteger(floor) || floor <= 0) return [];
  return [`--max-old-space-size=${Math.max(cap, floor)}`];
}
