#!/usr/bin/env node
/**
 * @file scripts/conveyor/actions-policy-watch.mjs
 * @description PRT-POLICY-WATCH: read-only daily check that org Actions policy 17152 still allows
 *   `pull_request_target` for merge-gate.yml ONLY, plus a changelog scan for allow-policy sunset posts.
 *   Missing permission or API error is `unknown`, never `ok`. Settings: scripts/settings/actions-policy-watch.json.
 *   Usage: node scripts/conveyor/actions-policy-watch.mjs --once --json [--org=<org>] [--state=<file>]
 *   Keep the same state file across scheduled runs. A stranded .lock directory needs operator recovery
 *   after confirming that its watcher has stopped; locks are never stolen from a slow live watcher.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../lib/atomic-json-file.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export function loadConfig(path = resolve(here, '../settings/actions-policy-watch.json')) {
  const cfg = JSON.parse(readFileSync(path, 'utf8')).actionsPolicyWatch;
  const nonempty = (s) => typeof s === 'string' && s.trim().length > 0;
  if (!cfg || !Number.isSafeInteger(cfg.policyId) || cfg.policyId <= 0
    || !nonempty(cfg.event) || !nonempty(cfg.expectedWorkflowPath)
    || !nonempty(cfg.policyEndpoint) || cfg.policyEndpoint.startsWith('-')
    || !cfg.policyEndpoint.includes('{org}') || !cfg.policyEndpoint.includes('{policyId}')
    || !nonempty(cfg.changelogFeed) || !/^https:\/\//.test(cfg.changelogFeed)
    || !Array.isArray(cfg.keywords) || !cfg.keywords.length || !cfg.keywords.every(nonempty)) {
    throw new Error('invalid actionsPolicyWatch settings: required keys and non-empty keywords must be present');
  }
  return cfg;
}

/** Pure: policy JSON -> {status: ok|drift|missing|unknown, reason}. */
export function evaluatePolicy(policy, cfg) {
  if (policy === null || policy === undefined) return { status: 'missing', reason: `policy ${cfg.policyId} not found` };
  if (typeof policy !== 'object' || Array.isArray(policy) || !Array.isArray(policy.rules)) {
    return { status: 'unknown', reason: 'unexpected policy response shape' };
  }
  if (policy.id !== cfg.policyId) return { status: 'unknown', reason: `policy id ${policy.id} is not ${cfg.policyId}` };
  const allowed = [];
  for (const rule of policy.rules) {
    if (rule?.event !== cfg.event) continue;
    if (!Array.isArray(rule.workflows)) return { status: 'unknown', reason: 'malformed workflows list' };
    allowed.push(...rule.workflows);
  }
  if (allowed.length === 0) return { status: 'missing', reason: `policy ${cfg.policyId} allows no ${cfg.event} workflow` };
  const extra = allowed.filter((w) => w !== cfg.expectedWorkflowPath);
  if (extra.length) return { status: 'drift', reason: `${cfg.event} also allowed for: ${extra.join(', ')}` };
  return { status: 'ok', reason: `${cfg.event} allowed for ${cfg.expectedWorkflowPath} only` };
}

/** Pure: unique items whose title, excerpt or full body match and whose id is not yet seen. */
export function evaluateChangelog(items, cfg, seen) {
  const kws = cfg.keywords.map((k) => k.toLowerCase());
  const ids = new Set(seen);
  return (items ?? []).filter((i) => {
    if (!i || ids.has(i.id)
      || !kws.some((k) => `${i.title ?? ''} ${i.summary ?? ''} ${i.content ?? ''}`.toLowerCase().includes(k))) return false;
    if (typeof i.id !== 'string' || !i.id.trim()) throw new Error('matching feed item has no stable id');
    ids.add(i.id);
    return true;
  });
}

export async function runWatch({ cfg, org, ghApi, fetchFeed, seen = new Set(), onAlert = () => {} }) {
  let policy;
  try {
    const endpoint = cfg.policyEndpoint ? cfg.policyEndpoint.replace('{org}', org).replace('{policyId}', cfg.policyId)
      : `orgs/${org}/actions/policies/${cfg.policyId}`;
    policy = evaluatePolicy(JSON.parse(await ghApi(endpoint)), cfg);
  } catch (e) {
    // 403/404 (or any error) is unreadable, never ok and never a confirmed absence (SHIP-API-014).
    policy = { status: 'unknown', reason: 'policy API unavailable or unreadable (403/404/other); check token admin:org read and the endpoint' };
  }
  // Deliver policy alerts before awaiting the feed; the returned aggregate alone cannot do this.
  const alerts = [];
  const emit = (message) => {
    const safe = message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
    alerts.push(safe);
    onAlert(safe);
  };
  if (policy.status !== 'ok') emit(`needs-you: actions policy ${cfg.policyId} ${policy.status}: ${policy.reason}`);
  let changelog = [];
  let feed = { status: 'ok' };
  try { changelog = evaluateChangelog(await fetchFeed(cfg.changelogFeed), cfg, seen); } catch (e) {
    feed = { status: 'unknown', reason: String(e?.message ?? e).slice(0, 120) };
    emit(`needs-you: changelog feed unreadable (${feed.reason}); sunset posts are unwatched`);
  }
  for (const i of changelog) emit(`needs-you: changelog "${i.title}" mentions the allow-policy (${i.id})`);
  return { policy, feed, changelog, alerts };
}

/** Pure: RSS or Atom text -> items. Throws when the text is not a feed. */
export function parseFeed(xml) {
  if (typeof xml !== 'string' || !/<(?:rss|feed)\b/.test(xml)) throw new Error('response is not an RSS/Atom feed');
  return [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => {
    const tag = (n) => (m[2].match(new RegExp(`<${n}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${n}>`)) ?? [])[1] ?? '';
    const content = [tag('content:encoded'), tag('content')].filter(Boolean).join(' ');
    return { id: tag('guid') || tag('id') || tag('link'), title: tag('title'),
      summary: tag('description') || tag('summary'), ...(content ? { content } : {}) };
  });
}

export async function fetchFeedText(url, fetchImpl = fetch) {
  const ctl = new AbortController();
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('changelog feed timed out after 15000ms'));
      ctl.abort();
    }, 15_000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const res = await fetchImpl(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
      return parseFeed(await res.text());
    })()]);
  } finally { clearTimeout(timer); }
}

/** Policy API invocation: a plain GET (no method, field or input flags). */
export const ghReadArgs = (endpoint) => ['api', endpoint];

/** Production wiring, injectable without replacing the state-handling path. Returns the CLI exit code. */
export async function main({ argv = process.argv.slice(2), exec = execFileSync, fetchImpl = fetch,
  env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let lock;
  try {
    const cfg = loadConfig();
    const orgArg = argv.find((a) => a.startsWith('--org='));
    const org = orgArg ? orgArg.slice(6) : env.GH_ORG
      || JSON.parse(exec('gh', ['repo', 'view', '--json', 'owner'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 })).owner.login;
    if (typeof org !== 'string' || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(org)) throw new Error('invalid organization');
    const stateArg = argv.find((a) => a.startsWith('--state='));
    const state = stateArg ? resolve(stateArg.slice(8))
      : resolve(here, '../../.conveyor', `actions-policy-watch-${org.toLowerCase()}-${cfg.policyId}.json`);
    mkdirSync(dirname(state), { recursive: true });
    try { mkdirSync(`${state}.lock`); } catch { throw new Error('state is locked or unwritable; check the watcher and recover its lock only after it stops'); }
    lock = `${state}.lock`;
    const scope = `${org.toLowerCase()}/${cfg.policyId}/${cfg.changelogFeed}`;
    let saved = { scope, seen: [] };
    try { saved = JSON.parse(readFileSync(state, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') throw new Error('state unreadable; restore the saved IDs before retrying');
    }
    if (saved?.scope !== scope || !Array.isArray(saved.seen)
      || !saved.seen.every((id) => typeof id === 'string' && id.trim())) throw new Error('state has an invalid scope or seen IDs');
    const seen = new Set(saved.seen);
    const json = argv.includes('--json');
    const result = await runWatch({
      cfg, org, seen, fetchFeed: (url) => fetchFeedText(url, fetchImpl),
      ghApi: async (endpoint) => exec('gh', ghReadArgs(endpoint), { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
      onAlert: (alert) => (json ? stderr : stdout).write(`${alert}\n`),
    });
    // IDs are acknowledged only after alert delivery succeeds. Atomic replacement preserves prior state on failure.
    result.changelog.forEach((item) => seen.add(item.id));
    try { writeJsonAtomic(state, { scope, seen: [...seen] }); } catch { throw new Error('state could not be saved; changelog alerts may repeat until storage is repaired'); }
    if (json) stdout.write(`${JSON.stringify(result)}\n`);
    else if (!result.alerts.length) stdout.write('ok\n');
    return result.alerts.length ? 1 : 0;
  } catch (e) {
    stderr.write(`needs-you: actions policy watcher ${String(e?.message ?? e).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')}\n`);
    return 1;
  } finally {
    if (lock) {
      try { rmdirSync(lock); } catch {
        stderr.write('needs-you: actions policy watcher state lock could not be released; recover it after the watcher stops\n');
        return 1;
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
