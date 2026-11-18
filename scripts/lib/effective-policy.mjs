/** Observations only: never resolve a policy again in the operator process. */
import { CAPACITY_LEAVES } from './operator-override-reader.mjs';
import { discoverDaemonLogPaths } from '../operations/daemon-log-paths.mjs';
import { openSync, fstatSync, readSync, closeSync } from 'node:fs';

const marker = /policy-cascade · ([\w.-]+): (.*)/;
const policyOf = key => key.slice(0, key.indexOf('.'));
const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

/** PURE: malformed/truncated values are unknown; the latest policy line replaces older leaves. */
export function parseCascadeLines(text) {
  const parsed = {};
  for (const line of String(text).split('\n')) {
    const match = line.match(marker);
    if (!match) continue;
    const suffix = match[2].match(/ · operator-gen=(\d+|unknown)$/);
    const n = suffix && suffix[1] !== 'unknown' ? Number(suffix[1]) : null;
    const gen = Number.isSafeInteger(n) && n >= 0 ? n : null;
    const body = suffix ? match[2].slice(0, suffix.index) : match[2];
    const leaves = {};
    // Match complete JSON values, including strings/objects containing commas or parentheses.
    const parts = /(?:^|, )([\w.-]+)=(.*?) \((standard|platform|tool|env|operator-db)\)(?=, | · ignored invalid:|$)/g;
    for (const part of body.matchAll(parts)) {
      try { Object.defineProperty(leaves, part[1], { value: { value: JSON.parse(part[2]), layer: part[3] }, enumerable: true, configurable: true }); }
      catch { /* Formatter truncates long values: refuse to guess. */ }
    }
    Object.defineProperty(parsed, match[1], { value: { gen, leaves }, enumerable: true, configurable: true });
  }
  return parsed;
}

/** PURE: every discovered daemon stays unknown until it logs the requested policy. */
export function effectiveForKeys(parsedByDaemon, keys) {
  return Object.fromEntries(keys.map(key => {
    const policy = policyOf(key), leaf = key.slice(policy.length + 1);
    return [key, Object.fromEntries(Object.entries(parsedByDaemon)
      .map(([daemon, policies]) => [daemon, { ...(policies[policy]?.leaves?.[leaf] ?? { value: null, layer: 'unknown' }), gen: policies[policy]?.gen ?? null }]))];
  }));
}

/** PURE: one warning per affected key, naming every shadowing/unknown daemon. Null means cleared. */
export function shadowWarnings(overrideValues, effective) {
  return Object.entries(overrideValues).flatMap(([key, override]) => {
    const rows = Object.entries(effective[key] ?? {});
    const bad = rows.filter(([, seen]) => seen.layer === 'unknown' || (override === null
      ? seen.layer === 'operator-db' : seen.layer !== 'operator-db' || !Object.is(seen.value, override)));
    const reasons = bad.map(([daemon, seen]) => `${daemon}: ${seen.layer === 'unknown' ? 'effective value unavailable'
      : override === null ? 'operator-db still active after clear' : `${seen.layer} shadows or differs from override (${JSON.stringify(seen.value)})`}`);
    if (!rows.length) reasons.push('no daemon evidence; inspect daemon logs');
    return reasons.length ? [clean(`${key}: ${reasons.join('; ')}`)] : [];
  });
}

/** PURE: shared shape for the optional show report. */
export function effectiveOverrideReport(values, parsedByDaemon, generation = null) {
  const keys = [...new Set([...Object.keys(values), ...Object.keys(CAPACITY_LEAVES).filter(key =>
    Object.values(parsedByDaemon).some(policies => Object.hasOwn(policies, policyOf(key))))])];
  const effective = effectiveForKeys(parsedByDaemon, keys);
  for (const rows of Object.values(effective)) for (const seen of Object.values(rows))
    seen.status = generation !== null && seen.gen !== null && seen.gen >= generation && seen.layer !== 'unknown' ? 'confirmed' : 'stale/unconfirmed';
  return { generation, effective: keys.map(key => ({ key, override: values[key] ?? null, daemons: effective[key] })),
    warnings: shadowWarnings(values, effective) };
}

/** Read a bounded tail from one descriptor. */
function policyTail(path, { maxBytes }) {
  const fd = openSync(path, 'r');
  try {
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - maxBytes), buffer = Buffer.alloc(size - start);
    const count = readSync(fd, buffer, 0, buffer.length, start);
    if (count !== buffer.length) throw Error('log truncated during read');
    // Drop the partial first line as bytes, before decoding a possible split UTF-8 character.
    const skip = start > 0 ? (buffer.includes(10) ? buffer.indexOf(10) + 1 : buffer.length) : 0;
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(skip));
    return { text };
  } finally { closeSync(fd); }
}

/** Bounded tails, independent failures. Missing logs remain unknown, never an empty success. */
export function readEffectivePolicies({ discover = discoverDaemonLogPaths, tail = policyTail, maxBytes = 512 * 1024 } = {}) {
  let paths;
  try { paths = discover(); } catch { return {}; }
  return Object.fromEntries(Object.entries(paths).map(([daemon, path]) => {
    let text = '';
    try {
      const result = tail(path, { maxBytes });
      if (result && !result.error) {
        text = result.text;
        if (result.truncated) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
      }
    } catch { /* Keep the daemon with unknown evidence. */ }
    const parsed = parseCascadeLines(text);
    return [daemon, parsed];
  }));
}

/** Capture before publication; only committed generations confirm observation. Write errors propagate. */
export async function writeWithEffective(input, { write, read = readEffectivePolicies,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), pollMs = 1000 } = {}) {
  const { waitMs = 120000, ...payload } = input;
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) throw Error('pollMs must be a positive integer');
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 120000)
    throw Error('--wait-ms must be an integer in 0..120000; use 0 to skip and inspect daemon logs');
  const safeRead = () => { try { return read(); } catch { return {}; } };
  const initial = safeRead();
  const result = await write(payload);
  const changes = result.changes ?? [{ key: result.key, new: result.new }];
  const values = Object.fromEntries(changes.map(c => [c.key, c.new])), keys = Object.keys(values);
  const before = effectiveForKeys(initial, keys);
  let latest = safeRead(), after, pending;
  const deadline = now() + waitMs;
  const inspect = () => {
    after = effectiveForKeys(latest, keys);
    pending = keys.flatMap(key => {
      const daemons = new Set([...Object.keys(before[key]), ...Object.keys(after[key])]);
      if (!daemons.size) return [`${key}: not yet seen by any daemon (inspect daemon logs)`];
      return [...daemons].flatMap(daemon => {
        const seen = after[key][daemon];
        const confirmed = Number.isSafeInteger(result.generation) && seen?.gen !== null
          && seen?.gen >= result.generation && seen.layer !== 'unknown';
        return confirmed ? [] : [clean(`${key}: unconfirmed (${daemon}: last seen gen ${seen?.gen ?? 'unknown'})`)];
      });
    });
  };
  inspect();
  // Bound iterations too, so an injected/non-advancing clock cannot make this unbounded.
  for (let left = Math.ceil(waitMs / pollMs); waitMs && pending.length && now() < deadline && left > 0; left--) {
    await sleep(Math.min(pollMs, deadline - now()));
    latest = safeRead(); inspect();
  }
  return { ...result, before, after, warnings: shadowWarnings(values, after),
    observation: waitMs === 0 ? 'skipped' : pending.length ? 'timeout' : 'observed', pending };
}
