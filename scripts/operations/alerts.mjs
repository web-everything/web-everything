/** Pure alert classification and the read-only alerts declaration. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';

export const ALERT_PATTERNS = Object.freeze({
  'needs-you': /^NEEDS-YOU /,
  'smoke-rejected': /smoke-rejected/,
  'daemon-held-on-last-good': /daemon-held-on-last-good \{/,
  'red-main': /red-main-hold: main is red since \d{4}-\d{2}-\d{2}/,
  'daemon-down': /\[high\] daemon-down/,
  'tick-exceeded': /tick exceeded/,
});
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/;

/** Classify before truncating, and exclude any referenced PR, including JSON and # forms. */
export function classifyAlertLine(line, { excludePrs = [] } = {}) {
  const prs = [...line.matchAll(/"pr"\s*:\s*"?(\d+)\b|#(\d+)\b/g)].map((m) => Number(m[1] ?? m[2]));
  const excluded = new Set([...excludePrs].map(Number));
  if (prs.some((pr) => excluded.has(pr))) return null;
  let record;
  if (line.trimStart().startsWith('{')) {
    try { record = JSON.parse(line); } catch { return null; }
  }
  const kind = record ? (Object.hasOwn(ALERT_PATTERNS, record.kind) ? record.kind : null)
    : Object.keys(ALERT_PATTERNS).find((name) => ALERT_PATTERNS[name].test(line));
  return kind ? { kind, pr: prs[0] ?? null, text: line.slice(0, 300) } : null;
}

/** Select only lines with their own timestamp inside the requested window. */
export function assessAlerts({ lines, observedAt }, { sinceMin = 30, excludePr = '' } = {}) {
  if (!Number.isFinite(sinceMin) || sinceMin < 0) throw new TypeError('sinceMin must be non-negative');
  const end = Date.parse(observedAt), start = end - sinceMin * 60_000;
  const grouped = new Map();
  for (const line of lines) {
    let timestamp = line.match(ISO)?.[0];
    if (line.trimStart().startsWith('{')) {
      try { timestamp = JSON.parse(line)?.at; } catch { continue; }
      if (typeof timestamp !== 'string' || timestamp.match(ISO)?.[0] !== timestamp) continue;
    }
    const at = Date.parse(timestamp ?? '');
    const alert = at >= start && at <= end && classifyAlertLine(line, { excludePrs: excludePr.split(',').filter(Boolean) });
    if (!alert) continue;
    const key = JSON.stringify([alert.kind, alert.text]);
    const previous = grouped.get(key);
    if (previous) previous.count++;
    else grouped.set(key, { ...alert, count: 1 });
  }
  return [...grouped.values()];
}

/** Bind the reader at the shell; both declared steps are compute steps. */
export function alertsOperation({ collect } = {}) {
  return op('alerts', {
    input: { sinceMin: { type: 'number', required: false, default: 30 }, excludePr: { type: 'string', required: false, default: '' } },
    verdictFrom: 'assess',
    read: compute({ reads: [], fn: () => collect() }),
    assess: compute({ reads: ['findings.read', 'input.sinceMin', 'input.excludePr'], fn: ({ findings, input }) => assessAlerts(findings.read, input) }),
  });
}
