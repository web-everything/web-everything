/** Host observations and best-effort decision/event persistence; never launches a provider. */
import { readFileSync, statSync, mkdirSync, appendFileSync, openSync, closeSync, readSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { daemonConveyorStateRoot } from './daemon-last-good.mjs';
import { readCodexQuota, readCodexBurnRate } from './codex-usage-ledger.mjs';
import { providerQuotaHold } from './provider-quota-hold.mjs';
import { appendDaemonEvent } from './daemon-events.mjs';
import { readProviderCapacity, burnWindows, bindingWindow, PROVIDER_DEFAULTS } from './provider-capacity.mjs';

function jsonFile(path) {
  try {
    const stat = statSync(path);
    if (stat.size > 2 * 1024 * 1024) return null; // Oversized evidence is unknown; calendar/fallback stays visible.
    return { ...JSON.parse(readFileSync(path, 'utf8')), mtime: stat.mtimeMs };
  } catch { return null; }
}
/** A bounded recent-ledger slope; resets/older windows cannot fabricate positive demand. */
export function recentCapacityRates(path, now, { read = readSync } = {}) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size, buffer = Buffer.alloc(Math.min(size, 256 * 1024));
    const bytes = read(fd, buffer, 0, buffer.length, size - buffer.length);
    const lines = buffer.subarray(0, bytes).toString('utf8').split('\n');
    if (size > buffer.length) lines.shift();
    const samples = new Map();
    for (const line of lines.slice(-512)) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      const at = Date.parse(row.at);
      if (at > now || now - at > 6 * 3600000) continue;
      for (const input of row.inputs ?? []) {
        if (!Number.isFinite(input.usedPercent) || !input.resetsAt) continue;
        const key = `${input.provider}/${input.account ?? ''}`;
        const list = samples.get(key) ?? []; list.push({ ...input, at }); samples.set(key, list);
      }
    }
    const rates = new Map();
    for (const [key, list] of samples) {
      list.sort((a, b) => a.at - b.at);
      const last = list.at(-1), first = list.find(s => s.resetsAt === last.resetsAt && s.at < last.at && s.usedPercent <= last.usedPercent);
      if (first) rates.set(key, (last.usedPercent - first.usedPercent) / ((last.at - first.at) / 3600000));
    }
    return rates;
  } catch { return new Map(); } finally { if (fd !== undefined) closeSync(fd); }
}
export function observeCapacity({ env = process.env, now = Date.now(), settings = {}, quota = readCodexQuota, records, readers } = {}) {
  const readersOff = env.WE_CAPACITY_READERS === 'off';
  const root = join(env.HOME || homedir(), '.plateau');
  records ??= readersOff ? [] : jsonFile(join(daemonConveyorStateRoot(env), '.conveyor', 'run-scorecards.json'))?.records ?? [];
  const configured = {};
  for (const p of settings.providers ?? PROVIDER_DEFAULTS.providers) for (const account of p.accounts ?? [{ id: p.id }]) {
    const specs = account.readers ?? p.readers;
    configured[account.id] = () => {
      for (const spec of specs ?? []) {
        let raw;
        if (spec.type === 'codex-rollout') raw = quota(env);
        else if (!readersOff && spec.type === 'plateau-usage-file' && typeof spec.file === 'string' && !isAbsolute(spec.file) && !spec.file.split(/[\\/]/).includes('..')) raw = jsonFile(join(root, spec.file));
        if (raw) return raw;
      }
      return null;
    };
  }
  const capacities = readProviderCapacity({ env, now, settings, readers: readers ?? { ...configured,
    hold: (p, at) => providerQuotaHold(records, p.startsWith('agy-') ? 'antigravity' : p, at),
  } });
  const rates = readersOff ? new Map() : recentCapacityRates(env.WE_CAPACITY_LEDGER || join(daemonConveyorStateRoot(env), 'capacity-decisions.jsonl'), now);
  return capacities.map(c => ({ ...c, currentRatePerHour: (c.quotaOf ?? c.provider) === 'codex'
    ? readCodexBurnRate({ env, now, lookbackHours: settings.rateLookbackHours ?? 24, window: bindingWindow(c) })
    : rates.get(`${c.quotaOf ?? c.provider}/${c.account ?? ''}`) ?? null }));
}

export function recordCapacityDecision(decision, { env = process.env, now = Date.now(), kind = 'build', capacities = [], settings = {},
  emit = e => appendDaemonEvent(e, { env }), append = appendFileSync } = {}) {
  const path = env.WE_CAPACITY_LEDGER || join(daemonConveyorStateRoot(env), 'capacity-decisions.jsonl');
  try {
    mkdirSync(dirname(path), { recursive: true });
    append(path, `${JSON.stringify({ at: new Date(now).toISOString(), kind, ...decision })}\n`, { mode: 0o600 });
    for (const window of burnWindows(capacities, { ...settings, now })) {
      // Exclusive create dedupes across processes as well as decisions. One tiny receipt per reset.
      const identity = createHash('sha256').update(JSON.stringify([window.kind, window.provider, window.account ?? null, window.resetsAt])).digest('hex');
      const receipt = join(dirname(path), `capacity-${identity}`);
      try { closeSync(openSync(receipt, 'wx', 0o600)); } catch { continue; }
      try { Promise.resolve(emit({ kind: window.kind, detail: window })).catch(() => {}); } catch { /* best effort */ }
    }
  } catch { /* observations must never stop delivery */ }
}
