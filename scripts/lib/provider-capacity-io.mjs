/** Host observations and best-effort decision/event persistence; never launches a provider. */
import { readFileSync, statSync, mkdirSync, appendFileSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { daemonConveyorStateRoot } from './daemon-last-good.mjs';
import { readCodexQuota } from './codex-usage-ledger.mjs';
import { providerQuotaHold } from './provider-quota-hold.mjs';
import { appendDaemonEvent } from './daemon-events.mjs';
import { readProviderCapacity, burnWindows } from './provider-capacity.mjs';

function jsonFile(path) {
  try {
    const stat = statSync(path);
    if (stat.size > 2 * 1024 * 1024) return null; // Oversized evidence is unknown; calendar/fallback stays visible.
    return { ...JSON.parse(readFileSync(path, 'utf8')), mtime: stat.mtimeMs };
  } catch { return null; }
}
export function observeCapacity({ env = process.env, now = Date.now(), settings = {}, quota = readCodexQuota, records, readers } = {}) {
  const root = join(env.HOME || homedir(), '.plateau');
  records ??= jsonFile(join(daemonConveyorStateRoot(env), '.conveyor', 'run-scorecards.json'))?.records ?? [];
  return readProviderCapacity({ env, now, settings, readers: readers ?? {
    codex: quota, claude: () => jsonFile(join(root, 'claude-usage.json')),
    'agy-gemini': () => jsonFile(join(root, 'agy-usage.json')),
    hold: (p, at) => providerQuotaHold(records, p.startsWith('agy-') ? 'antigravity' : p, at),
  } });
}

export function recordCapacityDecision(decision, { env = process.env, now = Date.now(), kind = 'build', capacities = [], settings = {},
  emit = e => appendDaemonEvent(e, { env }), append = appendFileSync } = {}) {
  const path = env.WE_CAPACITY_LEDGER || join(daemonConveyorStateRoot(env), 'capacity-decisions.jsonl');
  try {
    mkdirSync(dirname(path), { recursive: true });
    append(path, `${JSON.stringify({ at: new Date(now).toISOString(), kind, ...decision })}\n`, { mode: 0o600 });
    for (const window of burnWindows(capacities, { ...settings, now })) {
      // Exclusive create dedupes across processes as well as decisions. One tiny receipt per reset.
      const receipt = join(dirname(path), `capacity-burn-${window.provider}-${window.resetsAt}`);
      try { closeSync(openSync(receipt, 'wx', 0o600)); } catch { continue; }
      try { Promise.resolve(emit({ kind: 'capacity-burn-window', detail: window })).catch(() => {}); } catch { /* best effort */ }
    }
  } catch { /* observations must never stop delivery */ }
}
