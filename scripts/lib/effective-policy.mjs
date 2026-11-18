/** Observations only: never resolve a policy again in the operator process. */
import { discoverDaemonLogPaths } from '../operations/daemon-log-paths.mjs';
import { tailFile } from '../operations/daemon-status-io.mjs';

const marker = /policy-cascade · ([\w.-]+): (.*)/;
const evidence = Symbol('cascade evidence');
const policyOf = key => key.slice(0, key.indexOf('.'));
const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

/** PURE: malformed/truncated values are unknown; the latest policy line replaces older leaves. */
export function parseCascadeLines(text) {
  const parsed = {};
  for (const line of String(text).split('\n')) {
    const match = line.match(marker);
    if (!match) continue;
    const leaves = {};
    // Match complete JSON values, including strings/objects containing commas or parentheses.
    const parts = /(?:^|, )([\w.-]+)=(.*?) \((standard|platform|tool|env|operator-db)\)(?=, | · ignored invalid:|$)/g;
    for (const part of match[2].matchAll(parts)) {
      try { Object.defineProperty(leaves, part[1], { value: { value: JSON.parse(part[2]), layer: part[3] }, enumerable: true, configurable: true }); }
      catch { /* Formatter truncates long values: refuse to guess. */ }
    }
    Object.defineProperty(parsed, match[1], { value: leaves, enumerable: true, configurable: true });
  }
  return parsed;
}

/** PURE: a daemon with no readable policies remains explicitly unknown. */
export function effectiveForKeys(parsedByDaemon, keys) {
  return Object.fromEntries(keys.map(key => {
    const policy = policyOf(key), leaf = key.slice(policy.length + 1);
    return [key, Object.fromEntries(Object.entries(parsedByDaemon)
      .filter(([, policies]) => Object.hasOwn(policies, policy) || !Object.keys(policies).length)
      .map(([daemon, policies]) => [daemon, policies[policy]?.[leaf] ?? { value: null, layer: 'unknown' }]))];
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
export function effectiveOverrideReport(values, parsedByDaemon) {
  const effective = effectiveForKeys(parsedByDaemon, Object.keys(values));
  return { effective: Object.entries(values).map(([key, value]) => ({ key, override: value, daemons: effective[key] })),
    warnings: shadowWarnings(values, effective) };
}

/** Bounded tails, independent failures. Missing logs remain unknown, never an empty success. */
export function readEffectivePolicies({ discover = discoverDaemonLogPaths, tail = tailFile, maxBytes = 512 * 1024 } = {}) {
  let paths;
  try { paths = discover(); } catch { return {}; }
  return Object.fromEntries(Object.entries(paths).map(([daemon, path]) => {
    let text = '';
    try {
      const result = tail(path, { maxBytes });
      if (result && !result.error) text = result.truncated ? (result.text.includes('\n') ? result.text.slice(result.text.indexOf('\n') + 1) : '') : result.text;
    } catch { /* Keep the daemon with unknown evidence. */ }
    const parsed = parseCascadeLines(text), stamps = {};
    for (const line of text.split('\n')) {
      const match = line.match(marker);
      if (match) Object.defineProperty(stamps, match[1], { value: line, configurable: true });
    }
    Object.defineProperty(parsed, evidence, { value: stamps });
    return [daemon, parsed];
  }));
}

/** Capture BEFORE publication; only fresh policy evidence can confirm adoption. Write errors propagate. */
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
        const seen = after[key][daemon], policy = policyOf(key);
        const oldStamp = initial[daemon]?.[evidence]?.[policy];
        const newStamp = latest[daemon]?.[evidence]?.[policy];
        const fresh = newStamp !== undefined && newStamp !== oldStamp;
        const matches = seen && seen.layer !== 'unknown' && (values[key] === null
          ? seen.layer !== 'operator-db' : seen.layer === 'operator-db' && Object.is(seen.value, values[key]));
        return fresh && matches ? [] : [clean(`${key}: not yet seen by ${daemon}`)];
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
