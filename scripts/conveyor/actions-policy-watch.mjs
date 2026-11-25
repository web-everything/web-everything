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
  // Provisional response contract: confirm against a real admin:org fixture before relying on it.
  if (policy.enforcement === 'disabled' || policy.enforcement === 'evaluate') {
    return { status: 'drift', reason: `policy enforcement is ${policy.enforcement}` };
  }
  if (policy.enforcement !== 'active') return { status: 'unknown', reason: 'policy enforcement is not confirmed active' };
  const allowed = [];
  for (const rule of policy.rules) {
    if (!rule || typeof rule.event !== 'string' || !rule.event.trim()
      || !Array.isArray(rule.workflows) || !rule.workflows.every((w) => typeof w === 'string' && w.trim())) {
      return { status: 'unknown', reason: 'malformed policy rule or workflows list' };
    }
    if (rule?.event !== cfg.event) continue;
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

export async function runWatch({ cfg, org, ghApi, fetchFeed, seen = new Set(), onAlert = () => {}, beforeFeed = () => {} }) {
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
  const emit = async (message) => {
    const safe = message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
    alerts.push(safe);
    await onAlert(safe);
  };
  if (policy.status !== 'ok') await emit(`needs-you: actions policy ${cfg.policyId} ${policy.status}: ${policy.reason}`);
  // Dedupe storage is optional to the primary policy check, but mandatory before scanning the feed.
  await beforeFeed();
  let changelog = [];
  let feed = { status: 'ok' };
  try { changelog = evaluateChangelog(await fetchFeed(cfg.changelogFeed), cfg, seen); } catch (e) {
    feed = { status: 'unknown', reason: String(e?.message ?? e).slice(0, 120) };
    await emit(`needs-you: changelog feed unreadable (${feed.reason}); sunset posts are unwatched`);
  }
  for (const i of changelog) await emit(`needs-you: changelog "${i.title}" mentions the allow-policy (${i.id})`);
  return { policy, feed, changelog, alerts };
}

/** Pure: parse a complete RSS/Atom document. Unsupported XML (including DTDs) fails closed. */
export function parseFeed(xml) {
  if (typeof xml !== 'string') throw new Error('response is not an RSS/Atom feed');
  if (xml.length > 4 * 1024 * 1024) throw new Error('feed exceeds the 4 MiB text limit');
  const invalid = () => { throw new Error('malformed or incomplete RSS/Atom document'); };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(xml)) invalid();
  const decode = (text) => text.replace(/&(?:#x([\da-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));|&/g, (entity, hex, decimal, named) => {
    if (entity === '&') return invalid();
    if (named) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[named] ?? invalid();
    const code = parseInt(hex ?? decimal, hex ? 16 : 10);
    if (!(code === 9 || code === 10 || code === 13 || code >= 32 && code <= 0x10ffff)
      || code >= 0xd800 && code <= 0xdfff || code === 0xfffe || code === 0xffff) return invalid();
    return String.fromCodePoint(code);
  });
  // Sticky tokens cannot skip an unterminated tag, comment or CDATA section.
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/[A-Za-z_][\w.:-]*[\t\r\n ]*>|<[A-Za-z_][\w.:-]*(?:[\t\r\n ]+[A-Za-z_][\w.:-]*[\t\r\n ]*=[\t\r\n ]*(?:"[^"<]*"|'[^'<]*'))*[\t\r\n ]*\/?>|[^<]+/gy;
  const stack = [];
  let root;
  let offset = 0;
  while (offset < xml.length) {
    tokens.lastIndex = offset;
    const match = tokens.exec(xml);
    if (!match) invalid();
    const token = match[0];
    offset = tokens.lastIndex;
    if (token.startsWith('<!--')) {
      if (token.slice(4, -3).includes('--') || token.endsWith('--->')) invalid();
      continue;
    }
    if (token.startsWith('<?')) {
      // Only a leading XML declaration is supported; other processing instructions are unknown.
      if (match.index !== 0 || !/^<\?xml[\t\r\n ]+version=(?:"1\.0"|'1\.0')(?:[\t\r\n ]+encoding=(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:[\t\r\n ]+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?[\t\r\n ]*\?>$/.test(token)) invalid();
      continue;
    }
    if (token.startsWith('</')) {
      if (stack.pop()?.name !== token.slice(2, -1).trim()) invalid();
    } else if (token.startsWith('<![CDATA[')) {
      if (!stack.length) invalid();
      stack.at(-1).parts.push(token.slice(9, -3));
    } else if (token.startsWith('<')) {
      const name = token.match(/^<([A-Za-z_][\w.:-]*)/)[1];
      const attributes = [...token.matchAll(/[\t\r\n ]+([\w.:-]+)[\t\r\n ]*=[\t\r\n ]*(?:"([^"]*)"|'([^']*)')/g)];
      if (new Set(attributes.map((a) => a[1])).size !== attributes.length) invalid();
      attributes.forEach((a) => decode(a[2] ?? a[3]));
      const node = { name, parts: [] };
      if (stack.length) stack.at(-1).parts.push(node);
      else if (root) invalid();
      else root = node;
      if (!token.endsWith('/>')) stack.push(node);
      if (stack.length > 128) throw new Error('feed exceeds the 128 element nesting limit');
    } else {
      if (token.includes(']]>')) invalid();
      if (stack.length) stack.at(-1).parts.push(decode(token));
      else if (/[^\t\r\n ]/.test(token)) invalid();
    }
  }
  if (stack.length || !root || !['rss', 'feed'].includes(root.name)) invalid();
  const children = (node, name) => node.parts.filter((part) => typeof part === 'object' && part.name === name);
  const text = (node) => node.parts.map((part) => typeof part === 'string' ? part : text(part)).join('');
  const items = root.name === 'rss'
    ? children(root, 'channel').flatMap((channel) => children(channel, 'item')) : children(root, 'entry');
  if (!items.length) throw new Error('changelog feed contains no items');
  return items.map((item) => {
    const tag = (name) => children(item, name).map(text).join(' ');
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

/** A write returning true/false only describes buffering; its callback confirms delivery. */
function writeOutput(stream, text) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) {
      reject(new Error('output is already closed'));
      return;
    }
    const cleanup = () => {
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('output closed before delivery')); };
    stream.once('error', onError);
    stream.once('close', onClose);
    try {
      stream.write(text, (error) => {
        // Node emits 'error' after the failed callback. Keep its listener until that event/close.
        if (error) { reject(error); return; }
        cleanup();
        resolve();
      });
    } catch (error) { cleanup(); reject(error); }
  });
}

/** Production wiring, injectable without replacing the state-handling path. Returns the CLI exit code. */
export async function main({ argv = process.argv.slice(2), exec = execFileSync, fetchImpl = fetch,
  env = process.env, stdout = process.stdout, stderr = process.stderr, writeState = writeJsonAtomic } = {}) {
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
    const scope = `${org.toLowerCase()}/${cfg.policyId}/${cfg.changelogFeed}`;
    const seen = new Set();
    const json = argv.includes('--json');
    const result = await runWatch({
      cfg, org, seen, fetchFeed: (url) => fetchFeedText(url, fetchImpl),
      ghApi: async (endpoint) => exec('gh', ghReadArgs(endpoint), { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
      onAlert: (alert) => writeOutput(json ? stderr : stdout, `${alert}\n`),
      beforeFeed: () => {
        mkdirSync(dirname(state), { recursive: true });
        try { mkdirSync(`${state}.lock`); } catch { throw new Error('state is locked or unwritable; check the watcher and recover its lock only after it stops'); }
        lock = `${state}.lock`;
        let saved = { scope, seen: [] };
        try { saved = JSON.parse(readFileSync(state, 'utf8')); } catch (e) {
          if (e.code !== 'ENOENT') throw new Error('state unreadable; restore the saved IDs before retrying');
        }
        if (saved?.scope !== scope || !Array.isArray(saved.seen)
          || !saved.seen.every((id) => typeof id === 'string' && id.trim())) throw new Error('state has an invalid scope or seen IDs');
        saved.seen.forEach((id) => seen.add(id));
      },
    });
    if (json) await writeOutput(stdout, `${JSON.stringify(result)}\n`);
    else if (!result.alerts.length) await writeOutput(stdout, 'ok\n');
    // IDs are acknowledged only after alert delivery succeeds. Atomic replacement preserves prior state on failure.
    result.changelog.forEach((item) => seen.add(item.id));
    try { writeState(state, { scope, seen: [...seen] }); } catch { throw new Error('state could not be saved; changelog alerts may repeat until storage is repaired'); }
    return result.alerts.length ? 1 : 0;
  } catch (e) {
    try {
      if (!stderr.destroyed) await writeOutput(stderr, `needs-you: actions policy watcher ${String(e?.message ?? e).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')}\n`);
    } catch { /* A broken diagnostic stream still leaves the run failed and IDs unacknowledged. */ }
    return 1;
  } finally {
    if (lock) {
      try { rmdirSync(lock); } catch {
        try {
          if (!stderr.destroyed) await writeOutput(stderr, 'needs-you: actions policy watcher state lock could not be released; recover it after the watcher stops\n');
        } catch { /* The exit code also reports this failure when diagnostics cannot be delivered. */ }
        return 1;
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
