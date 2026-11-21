#!/usr/bin/env node
/**
 * D18 read-only plan/status. One-shot migration tooling, delete after phase 1.
 * No writer, PR, push or persistence flags. Bounds stop for operator inspection / smaller batches.
 * App-token-only GitHub GETs; local Git objects only, no fetching. IO injectable for hermetic tests.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { splitCard } from '../backlog-placement-trial.mjs';
import { buildManifest, verifyManifest, cardId, digest } from './manifest.mjs';
import { reconcile } from './reconcile.mjs';

const repo = 'repos/plateauapp/plateau-app';
const shaPattern = /^[a-f0-9]{40}$/;
export function parseArgs(args) {
  const [command, ...rest] = args, parsed = { command };
  const allowed = command === 'plan' ? ['cards', 'source-sha'] : command === 'status' ? ['manifest'] : [];
  if (!allowed.length) throw new Error('Use plan --cards <ids> --source-sha <sha> or status --manifest <path>');
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2), value = rest[i + 1];
    if (!rest[i].startsWith('--') || !allowed.includes(key) || parsed[key] || !value || value.startsWith('--')) throw new Error('Unknown, duplicate or missing argument; read-only flags only');
    parsed[key] = value;
  }
  if (allowed.some((key) => !parsed[key])) throw new Error('Missing required argument');
  if (command === 'plan') {
    parsed.cards = parsed.cards.split(','); parsed.sourceSha = parsed['source-sha']; delete parsed['source-sha'];
    if (parsed.cards.length > 20) throw new Error('Selection bound exceeded; use a smaller batch (at most 20 cards)');
    if (!shaPattern.test(parsed.sourceSha) || parsed.cards.some((id) => !/^[a-z0-9]+$/.test(id)) || new Set(parsed.cards).size !== parsed.cards.length) throw new Error('Invalid card ids or full source SHA');
  }
  return parsed;
}
/** Slice 3 (the writer) must call this first; slice 1 has no write path. Refuses without a GitHub App token. */
export function assertWriterToken(env = process.env) {
  const token = env.WE_GH_APP_TOKEN || env.GH_TOKEN;
  if (!/^ghs_[a-zA-Z0-9_]+$/.test(token || '')) throw new Error('GitHub App token required for any write path: GH_TOKEN (ghs_) or WE_GH_APP_TOKEN');
  return token;
}
export function main(args, io = {}) {
  const options = parseArgs(args), env = { ...(io.env ?? process.env) };
  delete env.GIT_DIR; delete env.GIT_WORK_TREE;
  env.GIT_NO_LAZY_FETCH = '1'; env.GIT_NO_REPLACE_OBJECTS = '1';
  // Direct, bounded GETs: gh-throttle persists locks/logs/memos, incompatible with this slice's zero writes.
  const run = io.run ?? execFileSync;
  const execute = (bin, argv) => run(bin, argv, { env, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const git = (...argv) => execute('git', ['--literal-pathspecs', ...argv]);
  const pin = (ref) => {
    const value = String(git('rev-parse', '--verify', `${ref}^{commit}`)).trim();
    if (!shaPattern.test(value)) throw new Error('Unverified Git SHA; inspect local branch evidence');
    return value;
  };
  const show = (sha, path) => git('show', `${sha}:${path}`);
  const paths = (sha) => {
    const names = String(git('ls-tree', '-r', '-z', '--name-only', sha, '--', 'backlog/')).split('\0').filter((p) => /^backlog\/[^/]+\.md$/.test(p));
    if (names.length > 20_000) throw new Error('Backlog bound exceeded; operator must inspect full tree');
    return names;
  };
  let manifest;
  if (options.command === 'status') {
    const raw = (io.read ?? readFileSync)(options.manifest);
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Manifest bound exceeded; use a smaller batch');
    manifest = JSON.parse(String(raw));
    if (!shaPattern.test(manifest.sourceSha) || !Array.isArray(manifest.cards) || manifest.cards.length > 20) throw new Error('Invalid manifest; inspect or use a smaller batch');
    for (const row of manifest.cards) cardId(row.sourcePath);
  }
  const sourceSha = pin(manifest?.sourceSha ?? options.sourceSha);
  if (sourceSha !== (manifest?.sourceSha ?? options.sourceSha)) throw new Error('Source SHA mismatch');
  const sourcePaths = paths(sourceSha);
  if (!manifest) manifest = buildManifest({ sourceSha, cards: options.cards.map((id) => {
    const matches = sourcePaths.filter((p) => p.startsWith(`backlog/${id}-`));
    if (matches.length !== 1) throw new Error('Missing or ambiguous source id; inspect snapshot');
    return { sourcePath: matches[0], bytes: show(sourceSha, matches[0]) };
  }) });
  verifyManifest(manifest, manifest.cards.map((r) => ({ sourcePath: r.sourcePath, bytes: show(sourceSha, r.sourcePath) })));
  const inbound = new Map(manifest.cards.map((r) => [r.sourcePath, []]));
  let scannedBytes = 0;
  for (const path of sourcePaths) {
    const text = String(show(sourceSha, path)); scannedBytes += Buffer.byteLength(text);
    if (scannedBytes > 64 * 1024 * 1024) throw new Error('Scan bound exceeded; operator must inspect inbound links manually');
    for (const row of manifest.cards) {
      const id = cardId(row.sourcePath);
      if (path !== row.sourcePath && (text.includes(row.sourcePath.split('/')[1]) || new RegExp(`(^|[^a-zA-Z0-9])#${id}(?![a-zA-Z0-9])`).test(text))) inbound.get(row.sourcePath).push(path);
    }
  }
  let login = 'unknown';
  try { login = String(execute('gh', ['api', '--method=GET', 'user', '--jq', '.login'])).trim() || 'unknown'; } catch { /* App tokens cannot read /user */ }
  (io.log ?? console.error)(`read-only dry run: using gh identity ${login}`);
  let calls = 0;
  const api = (endpoint, allow404 = false) => {
    if (++calls > 128) throw new Error('GitHub call bound exceeded; inspect manually or use smaller batch');
    let raw;
    try { raw = execute('gh', ['api', '--method=GET', endpoint]); }
    catch (error) {
      if (allow404 && /\bHTTP 404\b/.test(String(error.stderr))) return null;
      throw new Error('GitHub unreadable; stop batch and inspect credentials/default branch');
    }
    return JSON.parse(String(raw));
  };
  let sourceMainSha = null, currentPaths = [], destinationMainSha = null, listing, remoteFailed = false;
  // origin/main is the locally available main observation; never fetch implicitly in this dry run.
  try { sourceMainSha = pin('refs/remotes/origin/main'); currentPaths = paths(sourceMainSha); }
  catch { sourceMainSha = null; }
  try {
    const meta = api(repo);
    if (typeof meta.default_branch !== 'string' || !meta.default_branch) throw new Error('Missing default branch');
    destinationMainSha = api(`${repo}/commits/${encodeURIComponent(meta.default_branch)}`).sha;
    if (!shaPattern.test(destinationMainSha)) throw new Error('Unverified default-branch SHA');
    listing = api(`${repo}/contents/backlog?ref=${destinationMainSha}`, true) ?? [];
    if (!Array.isArray(listing) || listing.length >= 1000 || listing.some((f) => !f || typeof f.name !== 'string' || typeof f.type !== 'string'))
      throw new Error('Incomplete directory listing; operator must inspect full destination');
  } catch { remoteFailed = true; }
  const cards = [];
  for (const row of manifest.cards) {
    let F1 = 'unreadable', F2 = 'unreadable', F3 = false;
    try {
      if (sourceMainSha) {
        if (!currentPaths.includes(row.sourcePath)) F1 = 'absent';
        else {
          const bytes = show(sourceMainSha, row.sourcePath);
          const body = splitCard(String(bytes)).body.trim();
          F1 = digest(bytes) === row.sourceDigest ? 'same' : /^moved to a private store\.?$/i.test(body) ? 'stub' : 'changed';
        }
      }
    } catch { F1 = 'unreadable'; }
    try {
      if (!remoteFailed) {
        F2 = 'absent';
        for (const file of listing.filter((f) => f.name === row.destPath.split('/')[1] || f.name?.startsWith(`${row.destId}-`))) {
          if (file.type !== 'file' || !/^[a-z0-9_-]+\.md$/.test(file.name)) throw new Error('Unknown destination entry');
          const data = api(`${repo}/contents/backlog/${encodeURIComponent(file.name)}?ref=${destinationMainSha}`);
          if (data?.encoding !== 'base64' || typeof data.content !== 'string' || !/^[a-zA-Z0-9+/=\r\n]*$/.test(data.content)) throw new Error('Unreadable destination bytes');
          const bytes = Buffer.from(data.content, 'base64');
          if (bytes.toString('base64') !== data.content.replace(/[\r\n]/g, '')) throw new Error('Invalid destination byte encoding');
          if (file.name === row.destPath.split('/')[1]) F2 = digest(bytes) === row.destDigest ? 'destDigest' : 'other';
          if (F2 === 'other') continue; // Known divergent bytes quarantine regardless of identity metadata.
          const { front } = splitCard(String(bytes));
          if (front === null) throw new Error('Unreadable destination identity');
          const identity = front.match(/^formerly:[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s'"\r\n]+))[ \t]*\r?$/gm);
          if (!identity || identity.length !== 1) throw new Error('Missing or ambiguous destination identity');
          const value = identity[0].replace(/^formerly:[ \t]*/, '').trim().replace(/^["']|["']$/g, '');
          if (value !== row.bornAs) F3 = true;
        }
      }
    } catch { F2 = 'unreadable'; }
    cards.push({ ...row, target: row.classification, inboundLinks: inbound.get(row.sourcePath), F1, F2, F3, next: reconcile(row, F1, F2, F3) });
    if (['stop', 'quarantine'].includes(cards.at(-1).next.action)) break;
  }
  const timeET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', dateStyle: 'short', timeStyle: 'long', hour12: false }).format((io.now ?? (() => new Date()))());
  (io.print ?? console.log)(JSON.stringify({ ...manifest, sourceSha, sourceMainSha, destinationMainSha, timeET,
    sourceMainObservation: 'local refs/remotes/origin/main (no fetch)',
    remainingCards: manifest.cards.slice(cards.length).map((r) => r.bornAs), cards }, null, 2));
  return cards.some((r) => ['stop', 'quarantine'].includes(r.next.action)) ? 2 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch { console.error('STOP: evidence or arguments refused; inspect inputs/credentials and retry a smaller batch. No migration writes performed.'); process.exitCode = 2; }
}
