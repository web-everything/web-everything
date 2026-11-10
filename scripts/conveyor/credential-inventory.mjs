/** Read-only credential metadata and failed Actions signature collection (#4378). */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
export const DEFAULT_REPOS = Object.values(CONSTELLATION_REPOS).map((repo) => repo.slug);
export const DAY = 86400000;
const codes = new Set(['denied', 'unavailable', 'malformed', 'timeout', 'output-limit', 'incomplete']);
const repoName = (s) => typeof s === 'string' && /^[\w.-]+\/[\w.-]+$/.test(s);
const timestamp = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;
const text = (s) => typeof s === 'string' ? s.slice(0, 200).replace(/[\r\n\x00-\x1f]/g, '') : '';
const coverage = (s) => ({ complete: s?.complete === true, errors: [...new Set((s?.errors || []).filter((e) => codes.has(e)))] });
/** Allowlist projection, also used at the fixture/state boundary. No raw responses survive. */
export function normalizeInventory(input = {}) {
  const rows = new Map();
  for (const r of input.secrets || []) if (repoName(r?.repo) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(r?.name || '')) {
    const row = { repo: r.repo, name: r.name, updated_at: timestamp(r.updated_at) };
    const key = `${row.repo}/${row.name}`;
    // Conflicting duplicate timestamps are unknown, never silently fresh.
    if (rows.has(key) && rows.get(key).updated_at !== row.updated_at) row.updated_at = null;
    rows.set(key, row);
  }
  const findings = [];
  for (const r of input.ciFindings || []) if (repoName(r?.repo) && Number.isSafeInteger(r.runId) && r.runId > 0 && Number.isSafeInteger(r.attempt) && r.attempt > 0 && typeof r.badCredentials === 'boolean' && timestamp(r.observedAt)) {
    findings.push({ repo: r.repo, runId: r.runId, attempt: r.attempt, workflow: text(r.workflow), runUrl: `https://github.com/${r.repo}/actions/runs/${r.runId}`, observedAt: timestamp(r.observedAt), badCredentials: r.badCredentials });
  }
  const secrets = [...rows.values()].sort((a, b) => `${a.repo}/${a.name}`.localeCompare(`${b.repo}/${b.name}`));
  return { schemaVersion: 1, checkedAt: timestamp(input.checkedAt), lookbackHours: Number.isFinite(input.lookbackHours) && input.lookbackHours > 0 ? input.lookbackHours : 24,
    repositories: (input.repositories || []).filter((r) => repoName(r?.repo)).map((r) => ({ repo: r.repo, secrets: coverage(r.secrets), ci: coverage(r.ci) })),
    secrets, ciFindings: findings };
}
function errorCode(e) {
  if (e?.code === 'ETIMEDOUT' || e?.signal === 'SIGTERM') return 'timeout';
  if (e?.code === 'ENOBUFS') return 'output-limit';
  if (/\b(401|403)\b/.test(String(e?.stderr || ''))) return 'denied';
  return codes.has(e?.code) ? e.code : 'unavailable';
}
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
export function collectCredentialInventory({ repos = DEFAULT_REPOS, now = Date.now(), lookbackHours = 24, runLimit = 20, budgetMs = 20000, timeoutMs = 5000, maxBytes = 2 * 1024 * 1024, cache = [], clock = Date.now,
  exec = (cmd, args, options) => execFileSync(cmd, args, options) } = {}) {
  if (!repos.length || !repos.every(repoName) || !(lookbackHours > 0) || !Number.isInteger(runLimit) || runLimit < 1) fail('malformed');
  const result = { checkedAt: new Date(now).toISOString(), lookbackHours, repositories: [], secrets: [], ciFindings: [] };
  const deadline = clock() + budgetMs;
  const call = (args, json = true) => {
    const remaining = deadline - clock();
    if (remaining <= 0) fail('timeout');
    const raw = String(exec('gh', args, { encoding: 'utf8', timeout: Math.min(timeoutMs, remaining), maxBuffer: maxBytes, stdio: ['ignore', 'pipe', 'pipe'] }));
    if (Buffer.byteLength(raw) > maxBytes) fail('output-limit');
    if (!json) return raw;
    try { return JSON.parse(raw); } catch { fail('malformed'); }
  };
  const safeCache = normalizeInventory({ ciFindings: cache }).ciFindings;
  for (const repo of [...new Set(repos)].sort()) {
    const status = { repo, secrets: { complete: false, errors: [] }, ci: { complete: false, errors: [] } };
    result.repositories.push(status);
    for (const kind of ['secrets', 'ci']) {
      try {
        let count = 0; let total; const seen = new Set();
        for (let page = 1; ; page++) {
          if (page > 100) fail('incomplete');
          const endpoint = kind === 'secrets' ? `repos/${repo}/actions/secrets?per_page=100&page=${page}`
            : `repos/${repo}/actions/runs?status=failure&per_page=100&page=${page}`;
          const data = call(['api', '--method', 'GET', endpoint]);
          const list = data?.[kind === 'secrets' ? 'secrets' : 'workflow_runs'];
          if (!Array.isArray(list) || !Number.isInteger(data.total_count) || data.total_count < 0) fail('malformed');
          if (total !== undefined && total !== data.total_count) fail('incomplete');
          total = data.total_count;
          for (const row of list) {
            if (kind === 'secrets') {
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row?.name || '')) fail('malformed');
              seen.add(row.name);
              result.secrets.push({ repo, name: row.name, updated_at: row.updated_at });
              if (!timestamp(row.updated_at) || Date.parse(row.updated_at) > now) status.secrets.errors.push('malformed');
            } else {
              if (!Number.isSafeInteger(row?.id) || !timestamp(row.updated_at)) fail('malformed');
              seen.add(row.id);
              const at = Date.parse(row.updated_at);
              if (row.status !== 'completed' || row.conclusion !== 'failure' || at < now - lookbackHours * 3600000) continue;
              if (at > now || !Number.isSafeInteger(row.run_attempt) || row.run_attempt < 1) fail('malformed');
              if (++count > runLimit) fail('incomplete');
              const cached = safeCache.find((r) => r.repo === repo && r.runId === row.id && r.attempt === row.run_attempt && Date.parse(r.observedAt) >= at && Date.parse(r.observedAt) <= now);
              if (cached) result.ciFindings.push(cached);
              else {
                try {
                  const logs = call(['run', 'view', String(row.id), '--repo', repo, '--attempt', String(row.run_attempt), '--log-failed'], false);
                  if (!logs.trim()) fail('unavailable');
                  result.ciFindings.push({ repo, runId: row.id, attempt: row.run_attempt, workflow: row.name, observedAt: new Date(now).toISOString(), badCredentials: /bad credentials/i.test(logs) });
                } catch (e) { status.ci.errors.push(errorCode(e)); }
              }
            }
          }
          if (seen.size >= total) break;
          if (list.length < 100) fail('incomplete');
        }
        status[kind].complete = status[kind].errors.length === 0;
      } catch (e) { status[kind].errors.push(errorCode(e)); }
    }
  }
  return normalizeInventory(result);
}
export function inventoryComplete(result) { return result.repositories.every((r) => r.secrets.complete && r.ci.complete); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const flags = Object.fromEntries(process.argv.slice(2).map((s) => s.replace(/^--/, '').split('=')));
    const result = collectCredentialInventory({ ...(flags.repo ? { repos: flags.repo.split(',') } : {}), ...(flags['lookback-hours'] ? { lookbackHours: Number(flags['lookback-hours']) } : {}), ...(flags['run-limit'] ? { runLimit: Number(flags['run-limit']) } : {}) });
    console.log(JSON.stringify(result)); process.exitCode = inventoryComplete(result) ? 0 : 1;
  } catch { console.log(JSON.stringify({ schemaVersion: 1, error: 'malformed' })); process.exitCode = 1; }
}
