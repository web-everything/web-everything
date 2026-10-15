/** Read-only Codex spend report. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { codexUsageLedgerPath } from './lib/codex-usage-ledger.mjs';

export function aggregateCodexUsage(rows, { since = -Infinity } = {}) {
  const report = { runs: 0, quotaPercent: 0, quotaMeasuredRuns: 0, tokens: { input: 0, cached: 0, output: 0, reasoning: 0 }, byTaskKind: {}, byModel: {}, topCallers: [], changedNothing: [] };
  const callers = new Map();
  const add = (group, row) => {
    group.runs++;
    if (Number.isFinite(row.quota?.delta)) { group.quotaPercent += row.quota.delta; group.quotaMeasuredRuns++; }
    for (const k of Object.keys(group.tokens)) if (Number.isFinite(row.tokens?.[k])) group.tokens[k] += row.tokens[k];
  };
  const empty = () => ({ runs: 0, quotaPercent: 0, quotaMeasuredRuns: 0, tokens: { input: 0, cached: 0, output: 0, reasoning: 0 } });
  for (const row of rows) {
    if (!row || !Number.isFinite(Date.parse(row.at)) || Date.parse(row.at) < since) continue;
    add(report, row);
    for (const [key, field] of [['byTaskKind', 'taskKind'], ['byModel', 'model']]) {
      const name = row[field] || 'unknown';
      if (!Object.hasOwn(report[key], name)) Object.defineProperty(report[key], name, { value: empty(), enumerable: true });
      add(report[key][name], row);
    }
    const caller = row.caller || 'unknown';
    if (!callers.has(caller)) callers.set(caller, { caller, ...empty() });
    add(callers.get(caller), row);
    if (row.outcome?.changedFiles === false) report.changedNothing.push(row);
  }
  report.topCallers = [...callers.values()].sort((a, b) => b.quotaPercent - a.quotaPercent || b.runs - a.runs);
  return report;
}

export function parseSince(value, now = Date.now()) {
  const match = /^(\d+(?:\.\d+)?)(h|d|m)$/.exec(value);
  if (!match) throw new Error('--since must be a duration such as 24h, 7d or 30m');
  return now - Number(match[1]) * { h: 3600000, d: 86400000, m: 60000 }[match[2]];
}

export function readCodexUsageReport({ env = process.env, since = -Infinity } = {}) {
  let text;
  try { text = readFileSync(codexUsageLedgerPath(env), 'utf8'); } catch (e) { if (e.code === 'ENOENT') text = ''; else throw e; }
  const rows = text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  return aggregateCodexUsage(rows, { since });
}

export function formatCodexUsageReport(report) {
  const summary = (row) => `${row.runs} runs | quota ${row.quotaPercent.toFixed(2)} pp (${row.quotaMeasuredRuns} measured) | tokens input=${row.tokens.input} cached=${row.tokens.cached} output=${row.tokens.output} reasoning=${row.tokens.reasoning}`;
  return [summary(report), 'Quota observations can include concurrent runs; missing observations are excluded.',
    ...['byTaskKind', 'byModel'].flatMap(key => [key === 'byTaskKind' ? 'By task kind:' : 'By model:', ...Object.entries(report[key]).map(([name, value]) => `  ${name}: ${summary(value)}`)]),
    'Top callers:', ...report.topCallers.slice(0, 10).map(row => `  ${row.caller}: ${summary(row)}`),
    `Changed nothing: ${report.changedNothing.length} runs`, ...report.changedNothing.map(row => `  ${row.at} ${row.taskKind} ${row.model} ${row.caller} exit=${row.outcome.exit}${row.pr != null ? ` PR=${row.pr}` : ''}${row.card ? ` card=${row.card}` : ''}`),
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(a => a !== '--json' && !a.startsWith('--since='))) throw new Error('usage: node scripts/codex-usage-report.mjs [--since=24h] [--json]');
    const duration = args.find(a => a.startsWith('--since='))?.slice(8);
    const report = readCodexUsageReport({ since: duration === undefined ? -Infinity : parseSince(duration) });
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatCodexUsageReport(report));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
