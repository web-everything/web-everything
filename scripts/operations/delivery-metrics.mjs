#!/usr/bin/env node
/**
 * Delivery metrics v1 — read-only GitHub/ledger collector; only history is written.
 * Usage: node scripts/operations/delivery-metrics.mjs [--date=YYYY-MM-DD]
 *   [--backfill=N] [--dry-run] [--json]. Default: yesterday in America/New_York.
 * Backfill includes the selected day and its N-1 preceding calendar days (1..366).
 *
 * HISTORY CONTRACT (dashboard/digest must consume this, not scrape upstream):
 * delivery-metrics.jsonl in resolveCoordinationRoot(); one schemaVersion:1 row/date.
 * {schemaVersion,date,timezone,window:{since,until},collectedAt,settings,measures,
 *  deliveryProtocols:[{id,card,stage,ruleCount,fixtureCount,callerCount,evidence}]}
 * Each measure is {key,value,unit,n,source,reason?}; null ALWAYS has a reason.
 * n = population/sample size, not value. Windows are [since,until), DST aware.
 * Percentiles use coroner's nearest-rank estimator; absent samples are null.
 * Throughput counts merges in the day, with repo and product/delivery/unknown
 * splits. All touched paths must match a configured prefix for delivery; mixed
 * changes are product. Unreadable file lists are unknown, never guessed delivery.
 * Fix rounds = lifetime fix/ci-heal attempts before merge / merged PRs, including
 * zero-attempt PRs; incomplete bounded history makes this measure unavailable.
 * Needs-you episodes start in-day; wait p50 is for episodes cleared in-day,
 * paired by repo/PR/head/kind over full available feed; unresolved waits excluded.
 * Agreement reads drain ledger-shadow runs, attributed to the drain pass day.
 * Denominator is agree + disagree + unreadable; transient rows are excluded.
 * Unsafe = ledger-clears-label-holds, using the canonical shadow classification.
 * Sessions count coroner-observed starts by provider, not billing/usage totals.
 * No Gemini adapter exists yet: null rather than substituting agy sessions.
 * Protocol counts count declared evidence entries / JSON replay fixture files.
 * Stage is the contiguous ladder: rules -> fixtures -> daemon call-site evidence;
 * live means statically wired, not proof a feature switch is currently enabled.
 * Historical protocol stages reflect THIS checkout at collection time, not past
 * deployments. Decision coverage requires an explicit event census (at,protocol)
 * including unprotocolled decisions; stage completion is never used as coverage.
 * Optional coordination journals: incidents (at), restarts (at,kind), decisions
 * (at,protocol:string|null). Missing/invalid/truncated sources yield null, not zero.
 * Settings cascade: standard -> platform preferences -> feature settings -> env;
 * enabled/schedules log effective values and sources. No scheduling is installed.
 * History updates lock, validate, replace by date and atomically rename; corrupt
 * history refuses the write. Dry-run acquires no history lock and writes nothing.
 * No HTTP endpoint: body/rate/CSRF/reset-trigger controls do not apply.
 */
import * as fs from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolveCoordinationRoot } from './coordination-root.mjs';
import { readDeclaredSettings } from '../lib/settings-files.mjs';
import { withFileLock } from '../lib/atomic-json-file.mjs';
import { percentile, readBounded, makeGh, collectInputs } from './coroner-extract.mjs';
import { fixLoopLedgerPath, readFixLoopRows, isStubSession } from '../conveyor/fix-loop-ledger.mjs';
import { feedPath, replay, parseFeedLine } from './needs-you-feed.mjs';
import { readShadowRuns, reclassifyRow } from '../lib/ledger-promotion-readiness.mjs';
import { summarizeShadow } from '../lib/drain-ledger-shadow.mjs';
import { sharedRunsDir } from './run-store.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ZONE = 'America/New_York';
const CAP = 8 * 1024 * 1024;
const localDate = date => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
// utc-day-slice-ok: UTC-anchored calendar arithmetic on an explicit ET date, never the current UTC day.
const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
function validDate(date) {
  // utc-day-slice-ok: round-trip validation of an explicit calendar date anchored at UTC midnight.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('invalid calendar date');
}
export function dayWindow(date) {
  validDate(date);
  const midnight = day => {
    const utc = Date.parse(`${day}T00:00:00Z`);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, timeZoneName: 'shortOffset' }).formatToParts(new Date(utc + 12 * 3600000));
    // ET transitions occur after midnight; probe midnight's UTC candidates directly.
    const offset = Number(parts.find(p => p.type === 'timeZoneName').value.match(/GMT([+-]\d+)/)[1]);
    for (const h of [Math.abs(offset), 4, 5]) {
      const candidate = new Date(utc + h * 3600000);
      const hour = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: '2-digit', hourCycle: 'h23' }).format(candidate);
      if (localDate(candidate) === day && hour === '00') return candidate.toISOString();
    }
    throw new Error('ET midnight unavailable');
  };
  return { since: midnight(date), until: midnight(shift(date, 1)) };
}
export function backfillDates(date, days = 1) {
  validDate(date);
  if (!Number.isSafeInteger(days) || days < 1 || days > 366) throw new Error('backfill must be 1..366 days');
  return Array.from({ length: days }, (_, i) => shift(date, i - days + 1));
}
export function classifyPaths(paths, prefixes) {
  if (!Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== 'string')) return 'unknown';
  return paths.every(p => prefixes.some(prefix => p.startsWith(prefix))) ? 'delivery' : 'product';
}
const json = path => JSON.parse(fs.readFileSync(path, 'utf8'));
export function resolveSettings({ env = process.env, file, platform } = {}) {
  const declared = file ? null : readDeclaredSettings();
  file ??= declared.settings;
  if (!platform) { try { platform = json(join(ROOT, 'scripts/lib/delivery-platform-preferences.json')); } catch { platform = {}; } }
  const defaults = { enabled: true, schedule: { frequency: 'daily', time: '00:15', timezone: ZONE }, digestSchedule: { frequency: 'weekly', day: 'Sunday', time: '20:00', timezone: ZONE }, deliveryPaths: [], protocols: [], sources: {} };
  const result = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    let value = fallback, source = 'standard';
    for (const [layer, label] of [[platform, 'platform'], [file, 'settings/delivery-metrics.json']]) {
      const raw = key === 'digestSchedule' ? layer?.delivery?.digest?.schedule : layer?.delivery?.metrics?.[key];
      if (raw !== undefined) { value = raw; source = label; }
    }
    const variable = { enabled: 'WE_DELIVERY_METRICS_ENABLED', schedule: 'WE_DELIVERY_METRICS_SCHEDULE', digestSchedule: 'WE_DELIVERY_DIGEST_SCHEDULE' }[key];
    if (variable && env[variable] !== undefined) {
      try { const parsed = JSON.parse(env[variable]); if (key === 'enabled' ? typeof parsed === 'boolean' : parsed && typeof parsed === 'object') { value = parsed; source = 'env'; } } catch { /* invalid override retains lower layer */ }
    }
    result[key] = { value, source };
  }
  return result;
}
const inDay = (at, window) => Date.parse(at) >= Date.parse(window.since) && Date.parse(at) < Date.parse(window.until);
const missing = (source, reason = 'source unavailable') => ({ source, reason });
const good = source => source && !source.reason && Array.isArray(source.rows);

export function protocolProgress(protocols, { root = ROOT } = {}) {
  const content = entry => {
    if (!entry?.path || isAbsolute(entry.path) || entry.path.split('/').includes('..')) return false;
    try { return fs.readFileSync(join(root, entry.path), 'utf8').includes(entry.contains ?? ''); } catch { return false; }
  };
  return protocols.map(p => {
    const rules = (p.rules ?? []).filter(content), fixtures = (p.fixtures ?? []).filter(content), callers = (p.callers ?? []).filter(content);
    if (p.fixtureDirectory && !isAbsolute(p.fixtureDirectory) && !p.fixtureDirectory.split('/').includes('..')) {
      try { for (const name of fs.readdirSync(join(root, p.fixtureDirectory)).filter(n => n.endsWith('.json')).sort()) { json(join(root, p.fixtureDirectory, name)); fixtures.push({ path: `${p.fixtureDirectory}/${name}` }); } } catch { /* no valid fixture evidence */ }
    }
    const defined = rules.length > 0 && rules.length === (p.rules ?? []).length;
    const stage = !defined ? 'proposed' : !fixtures.length ? 'defined' : callers.length ? 'live' : 'fixtures';
    return { id: p.id, card: p.card ?? null, stage, ruleCount: rules.length, fixtureCount: fixtures.length, callerCount: callers.length, evidence: { rules, fixtures, callers } };
  });
}
export function snapshot({ date, inputs = {}, settings, now = new Date(), root = ROOT }) {
  const window = dayWindow(date), effective = resolveSettings({ file: settings, env: {} });
  const measures = [];
  const add = (key, value, unit, n, src, reason) => measures.push({ key, value: reason ? null : value, unit, n, source: src?.source ?? 'unavailable', ...(reason ? { reason } : {}) });
  const rows = key => good(inputs[key]) ? inputs[key].rows.filter(r => inDay(r.at, window)) : [];
  const reason = key => good(inputs[key]) ? undefined : inputs[key]?.reason ?? 'source unavailable';
  const prs = good(inputs.prs) ? inputs.prs.rows.filter(p => inDay(p.mergedAt, window)) : [];
  add('throughput.total', prs.length, 'PRs', prs.length, inputs.prs, reason('prs'));
  for (const repo of [...new Set([...Object.keys(CONSTELLATION_REPOS), ...prs.map(p => p.repo)])]) for (const kind of ['product', 'delivery', 'unknown']) {
    add(`throughput.${repo}.${kind}`, prs.filter(p => p.repo === repo && classifyPaths(p.files, effective.deliveryPaths.value) === kind).length, 'PRs', prs.filter(p => p.repo === repo).length, inputs.prs, reason('prs'));
  }
  const lead = prs.map(p => (Date.parse(p.mergedAt) - Date.parse(p.createdAt)) / 3600000).filter(n => Number.isFinite(n) && n >= 0);
  for (const p of [50, 90]) add(`lead-time.p${p}`, percentile(lead, p / 100), 'hours', lead.length, inputs.prs, reason('prs') ?? (!lead.length ? 'no merged PR lead-time samples' : undefined));
  const rounds = good(inputs.fixes) ? inputs.fixes.rows.filter(r => ['fix', 'ci-heal'].includes(r.kind) && prs.some(p => p.repo === r.repo && p.number === r.pr && Date.parse(r.at) <= Date.parse(p.mergedAt))).length : 0;
  add('fix-rounds.mean', rounds / prs.length, 'rounds/PR', prs.length, inputs.fixes, reason('fixes') ?? reason('prs') ?? (!prs.length ? 'no merged PRs' : undefined));
  const events = good(inputs.needsYou) ? inputs.needsYou.rows.filter(r => Date.parse(r.at) < Date.parse(window.until)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) : [];
  const open = new Map(), waits = [];
  for (const e of events) {
    const key = `${e.repo}#${e.pr}@${e.head}:${e.kind === 'cleared' ? e.was : e.kind}`;
    if (e.kind !== 'cleared') { if (!open.has(key)) open.set(key, e); }
    else if (open.has(key)) { if (inDay(e.at, window)) waits.push((Date.parse(e.at) - Date.parse(open.get(key).at)) / 3600000); open.delete(key); }
  }
  add('needs-you.episodes', rows('needsYou').filter(e => e.kind !== 'cleared').length, 'episodes', rows('needsYou').length, inputs.needsYou, reason('needsYou'));
  add('needs-you.wait.p50', percentile(waits, .5), 'hours', waits.length, inputs.needsYou, reason('needsYou') ?? (!waits.length ? 'no completed episodes' : undefined));
  const agreement = rows('agreement'), summary = summarizeShadow(agreement), compared = summary.agree + summary.disagree + summary.unreadable;
  add('verdict-ledger.agreement', 100 * summary.agree / compared, 'percent', compared, inputs.agreement, reason('agreement') ?? (!compared ? 'no drain shadow comparisons' : undefined));
  add('verdict-ledger.unsafe', summary.directions['ledger-clears-label-holds'], 'disagreements', compared, inputs.agreement, reason('agreement'));
  add('coroner.incidents', rows('incidents').length, 'incidents', rows('incidents').length, inputs.incidents, reason('incidents'));
  for (const kind of ['restart', 'crash']) add(`daemon.${kind === 'restart' ? 'restarts' : 'crashes'}`, rows('restarts').filter(r => r.kind === kind).length, 'events', rows('restarts').length, inputs.restarts, reason('restarts'));
  for (const provider of ['claude', 'codex', 'gemini']) {
    const src = inputs.sessionsByProvider?.[provider] ?? inputs.sessions;
    const sessions = good(src) ? src.rows.filter(r => inDay(r.at, window) && r.provider?.toLowerCase() === provider) : [];
    add(`sessions.${provider}`, sessions.length, 'sessions', sessions.length, src, good(src) ? undefined : src?.reason ?? 'source unavailable');
  }
  const decisions = rows('decisions'), ids = new Set(effective.protocols.value.map(p => p.id));
  add('delivery-protocols.coverage', 100 * decisions.filter(r => ids.has(r.protocol)).length / decisions.length, 'percent', decisions.length, inputs.decisions, reason('decisions') ?? (!decisions.length ? 'no decision census events' : undefined));
  return { schemaVersion: 1, date, timezone: ZONE, window, collectedAt: new Date(now).toISOString(), settings: effective, measures, deliveryProtocols: protocolProgress(effective.protocols.value, { root }) };
}

/** Complete reads only: bounded reader truncation or invalid JSON never becomes an empty source. */
function readSource(path, source, parse = text => text.split('\n').filter(Boolean).map(JSON.parse), cap = CAP) {
  const data = readBounded(path, { cap, maxLine: cap });
  if (!data.found || data.truncated) return missing(source, data.truncated ? 'source truncated' : 'source missing or unreadable');
  try {
    // Full bounded read, never a second unbounded read of a growing shared file.
    const text = data.lines.join('\n');
    if (fs.statSync(path).size !== data.bytesRead) return missing(source, 'source changed or incomplete');
    return { source, rows: parse(text) };
  } catch { return missing(source, 'source malformed or unreadable'); }
}
export function collectMerged(repo, window, gh) {
  const source = `github:${repo}:merged`, slug = CONSTELLATION_REPOS[repo].slug, rows = [];
  try {
    const query = `repo:${slug} is:pr is:merged merged:>=${window.since} merged:<${window.until}`;
    let expected;
    for (let page = 1; page <= 10; page++) {
      const result = gh(['api', `search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}`]);
      if (!result || result.incomplete_results || !Array.isArray(result.items) || !Number.isInteger(result.total_count) || result.total_count > 1000) return missing(source, 'GitHub merge search incomplete');
      expected ??= result.total_count;
      if (expected !== result.total_count) return missing(source, 'GitHub merge search changed');
      for (const item of result.items) {
        const pr = gh(['api', `repos/${slug}/pulls/${item.number}`]);
        if (!Number.isFinite(Date.parse(pr?.merged_at)) || !Number.isFinite(Date.parse(pr?.created_at))) return missing(source, 'GitHub PR detail unavailable');
        let files = [], complete = false;
        for (let fp = 1; fp <= 31; fp++) {
          const batch = gh(['api', `repos/${slug}/pulls/${item.number}/files?per_page=100&page=${fp}`]);
          if (!Array.isArray(batch) || batch.some(f => typeof f.filename !== 'string')) break;
          files.push(...batch.map(f => f.filename));
          if (batch.length < 100) { complete = true; break; }
        }
        rows.push({ repo, number: item.number, createdAt: pr.created_at, mergedAt: pr.merged_at, files: complete && (pr.changed_files === undefined || pr.changed_files === files.length) ? files : null });
      }
      if (result.items.length < 100) break;
    }
    if (rows.length !== expected || new Set(rows.map(p => p.number)).size !== rows.length) return missing(source, 'GitHub merge search truncated or unstable');
    return { source, rows };
  } catch { return missing(source, 'GitHub read failed'); }
}
/** Use the existing run-history reader without resolveRunsDir's legacy migration writes. */
export function collectAgreement(date, { env = process.env, readShadow = readShadowRuns } = {}) {
  const source = 'drain-ledger-shadow:run-history', window = dayWindow(date);
  const dir = env.OPERATION_RUNS_DIR?.trim() || sharedRunsDir(env);
  try {
    if (!fs.statSync(dir).isDirectory()) return missing(source);
    const history = readShadow({ dir });
    if (history.corrupt) return missing(source, 'shadow history incomplete: corrupt run records');
    const runs = history.runs.filter(r => inDay(r.input?.at, window));
    if (runs.some(r => r.findings?.rowsTruncated || !Array.isArray(r.findings?.rows))) return missing(source, 'shadow history incomplete: truncated comparison rows');
    const rows = runs.flatMap(r => r.findings.rows.map(row => ({ ...reclassifyRow({ ...row, schema: r.input.schema ?? row.schema }), at: r.input.at })));
    if (rows.some(r => !['agree', 'disagree', 'unreadable', 'transient'].includes(r.status))) return missing(source, 'shadow history incomplete: invalid comparison');
    return { source, rows };
  } catch { return missing(source, 'shadow history missing or unreadable'); }
}
export async function collectDay(date, { env = process.env, settings, gh = makeGh({ env }), readShadow = readShadowRuns, coroner = collectInputs } = {}) {
  const window = dayWindow(date), coord = resolveCoordinationRoot({ env }), effective = resolveSettings({ env, file: settings });
  const sources = effective.sources.value, inputs = {};
  const prs = Object.keys(CONSTELLATION_REPOS).map(repo => collectMerged(repo, window, gh));
  inputs.prs = prs.every(good) ? { source: 'github:constellation:merged', rows: prs.flatMap(p => p.rows) } : missing('github:constellation:merged', prs.filter(p => !good(p)).map(p => `${p.source}: ${p.reason}`).join('; '));
  const fixPath = fixLoopLedgerPath(env);
  inputs.fixes = readSource(fixPath, 'fix-loop-ledger', text => {
    const raw = text.split('\n').filter(Boolean).map(JSON.parse);
    const rows = readFixLoopRows({ env });
    if (raw.filter(r => !isStubSession(r?.session)).length !== rows.length) throw new Error('invalid ledger rows');
    return rows;
  }, 1024 * 1024);
  const feed = feedPath({ env });
  inputs.needsYou = readSource(feed, 'needs-you-feed', text => { if (text.split('\n').filter(Boolean).some(line => !parseFeedLine(line))) throw new Error('invalid feed'); return replay({ path: feed }); });
  inputs.agreement = collectAgreement(date, { env, readShadow });
  for (const key of ['incidents', 'restarts', 'decisions']) {
    const path = sources[key];
    inputs[key] = typeof path === 'string' && !isAbsolute(path) && !path.split('/').includes('..') ? readSource(join(coord, path), `coordination:${path}`) : missing(key, 'no timestamped event source declared');
    if (good(inputs[key]) && inputs[key].rows.some(r => !Number.isFinite(Date.parse(r?.at)) || (key === 'restarts' && !['restart', 'crash'].includes(r.kind)) || (key === 'decisions' && r.protocol !== null && typeof r.protocol !== 'string'))) inputs[key] = missing(inputs[key].source, 'invalid event schema');
  }
  try {
    const data = coroner(window, { env: { ...env, WE_CORONER_COORD: coord }, gh: null });
    inputs.sessionsByProvider = {
      claude: data.sources.jobs.found || data.sources.archive.found ? { source: 'coroner:worker-job-starts', rows: data.sessions.map(s => ({ at: s.state.createdAt || s.state.updatedAt, provider: 'claude' })) } : missing('coroner:worker-job-starts'),
      codex: data.sources.codexSessions?.count >= 600 ? missing('coroner:codex-rollouts', 'session census reached reader cap (600)') : data.sources.codexSessions?.found ? { source: 'coroner:codex-rollouts', rows: (data.executorRuns?.codex ?? []).map(s => ({ at: s.at, provider: 'codex' })) } : missing('coroner:codex-rollouts'),
      gemini: missing('gemini', 'no Gemini session reader declared'),
    };
  } catch { inputs.sessions = missing('coroner', 'session sources unreadable'); }
  return inputs;
}
export function writeHistory(file, rows) {
  fs.mkdirSync(dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, () => {
    let previous = [];
    try { previous = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const row of [...previous, ...rows]) { validDate(row.date); if (row.schemaVersion !== 1) throw new Error('unsupported history schema'); }
    const byDate = new Map(previous.map(row => [row.date, row]));
    for (const row of rows) byDate.set(row.date, row);
    const tmp = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).map(JSON.stringify).join('\n') + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
    finally { try { fs.unlinkSync(tmp); } catch { /* renamed or never created */ } }
  });
}
export async function main(argv = process.argv.slice(2), { env = process.env, now = new Date(), settings, collect, write = writeHistory, output = console.log, log = console.error } = {}) {
  const flags = {};
  for (const arg of argv) {
    const match = /^--(date|backfill)=(.+)$/.exec(arg);
    if (match) { if (flags[match[1]] !== undefined) throw new Error('duplicate option'); flags[match[1]] = match[2]; }
    else if (['--json', '--dry-run'].includes(arg)) flags[arg.slice(2)] = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  const effective = resolveSettings({ env, file: settings });
  for (const key of ['enabled', 'schedule', 'digestSchedule']) log(`${{ enabled: 'delivery.metrics.enabled', schedule: 'delivery.metrics.schedule', digestSchedule: 'delivery.digest.schedule' }[key]}=${JSON.stringify(effective[key].value)} source=${effective[key].source}`);
  if (effective.enabled.value === false) { if (flags.json) output('[]'); return []; }
  const date = flags.date ?? shift(localDate(now), -1), dates = backfillDates(date, flags.backfill === undefined ? 1 : Number(flags.backfill));
  const rows = [];
  const resolvedFile = { delivery: { metrics: Object.fromEntries(Object.entries(effective).filter(([k]) => k !== 'digestSchedule').map(([k, v]) => [k, v.value])), digest: { schedule: effective.digestSchedule.value } } };
  for (const day of dates) {
    const inputs = await (collect ?? (d => collectDay(d, { env, settings: resolvedFile })))(day);
    const row = snapshot({ date: day, inputs, settings: resolvedFile, now });
    row.settings = effective;
    rows.push(row);
  }
  if (!flags['dry-run']) write(join(resolveCoordinationRoot({ env }), 'delivery-metrics.jsonl'), rows);
  output(flags.json ? JSON.stringify(rows.length === 1 ? rows[0] : rows) : rows.map(r => `${r.date}: ${r.measures.filter(m => m.value !== null).length}/${r.measures.length} measures available${flags['dry-run'] ? ' (dry-run)' : ''}`).join('\n'));
  return rows;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('delivery-metrics: collection/history update failed'); process.exitCode = 1; });
