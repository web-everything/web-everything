#!/usr/bin/env node
/**
 * @file scripts/conveyor/actions-policy-watch.mjs
 * @description PRT-POLICY-WATCH: read-only daily check that org Actions policy 17152 still allows
 *   `pull_request_target` for merge-gate.yml ONLY, plus a changelog scan for allow-policy sunset posts.
 *   Missing permission or API error is `unknown`, never `ok`. Settings: scripts/settings/actions-policy-watch.json.
 *   Usage: node scripts/conveyor/actions-policy-watch.mjs --once --json [--org=<org>]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function loadConfig(path = resolve(here, '../settings/actions-policy-watch.json')) {
  return JSON.parse(readFileSync(path, 'utf8')).actionsPolicyWatch;
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

/** Pure: items whose title/summary contain a keyword and whose id is not yet seen. */
export function evaluateChangelog(items, cfg, seen) {
  const kws = (cfg.keywords ?? []).map((k) => k.toLowerCase());
  return (items ?? []).filter((i) => i && !seen.has(i.id)
    && kws.some((k) => `${i.title ?? ''} ${i.summary ?? ''}`.toLowerCase().includes(k)));
}

export async function runWatch({ cfg, org, ghApi, fetchFeed, seen = new Set() }) {
  let policy;
  try {
    const endpoint = cfg.policyEndpoint ? cfg.policyEndpoint.replace('{org}', org).replace('{policyId}', cfg.policyId)
      : `orgs/${org}/actions/policies/${cfg.policyId}`;
    policy = evaluatePolicy(JSON.parse(await ghApi(endpoint)), cfg);
  } catch (e) {
    // 403/404 (or any error) is unreadable, never ok and never a confirmed absence (SHIP-API-014).
    policy = { status: 'unknown', reason: 'policy API unavailable or unreadable (403/404/other); check token admin:org read and the endpoint' };
  }
  // Policy alert is built first so a slow or failing feed can never withhold it.
  const alerts = [];
  if (policy.status !== 'ok') alerts.push(`needs-you: actions policy ${cfg.policyId} ${policy.status}: ${policy.reason}`);
  let changelog = [];
  let feed = { status: 'ok' };
  try { changelog = evaluateChangelog(await fetchFeed(cfg.changelogFeed), cfg, seen); } catch (e) {
    feed = { status: 'unknown', reason: String(e?.message ?? e).slice(0, 120) };
    alerts.push(`needs-you: changelog feed unreadable (${feed.reason}); sunset posts are unwatched`);
  }
  for (const i of changelog) alerts.push(`needs-you: changelog "${i.title}" mentions the allow-policy (${i.id})`);
  return { policy, feed, changelog, alerts };
}

/** Pure: RSS or Atom text -> items. Throws when the text is not a feed. */
export function parseFeed(xml) {
  if (typeof xml !== 'string' || !/<(?:rss|feed)\b/.test(xml)) throw new Error('response is not an RSS/Atom feed');
  return [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => {
    const tag = (n) => (m[2].match(new RegExp(`<${n}\\b[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${n}>`)) ?? [])[1] ?? '';
    return { id: tag('guid') || tag('id') || tag('link'), title: tag('title'), summary: tag('description') || tag('summary') };
  });
}

export async function fetchFeedText(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  return parseFeed(await res.text());
}

/** The only gh invocation: a plain GET (no method, field or input flags). */
export const ghReadArgs = (endpoint) => ['api', endpoint];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();
  const orgArg = argv.find((a) => a.startsWith('--org='));
  const org = orgArg ? orgArg.slice(6) : process.env.GH_ORG
    || JSON.parse(execFileSync('gh', ['repo', 'view', '--json', 'owner'], { encoding: 'utf8', maxBuffer: 1024 * 1024 })).owner.login;
  const result = await runWatch({
    cfg, org, fetchFeed: fetchFeedText,
    ghApi: async (endpoint) => execFileSync('gh', ghReadArgs(endpoint), { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
  });
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(result)}\n` : `${result.alerts.join('\n') || 'ok'}\n`);
  process.exitCode = result.alerts.length ? 1 : 0;
}
