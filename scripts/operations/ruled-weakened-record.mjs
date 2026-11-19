#!/usr/bin/env node
/** Record approved waivers only for current code; replay never resurrects stale waivers. */
import fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { appendEntry, readStore, storePath, validateEntry, findingsHash } from './ruled-weakened-store.mjs';
import { QUESTION_HASH, findAudit } from './codex-audit.mjs';
import { netDiffFingerprint, carriesAcross } from '../lib/net-diff-fingerprint.mjs';

const bareRef = ref => String(ref ?? '').replace(/\s*\(.*\)\s*$/, '').trim();
const shaKey = sha => typeof sha === 'string' ? sha.toLowerCase() : '';
const key = entry => JSON.stringify([bareRef(entry.ref), shaKey(entry.sha)]);
const identity = entry => JSON.stringify([entry.ref, shaKey(entry.sha), entry.ruling]);
const validSha = sha => typeof sha === 'string' && /^[a-f0-9]{40}$/i.test(sha);
const validRef = ref => typeof ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
  && !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/') && !ref.endsWith('.lock');

/** Pure selection with synchronous injected lookups. carries returns the proven net-diff fingerprint, or null; a boolean alone grants no waiver. */
export function recordEntries({ approvals, requests, rulings, entries, latestAudit, headOf, carries, now }) {
  const approved = new Map(approvals.map(a => [key(a), a]));
  const withdrawn = new Set(requests.filter(r => r.ruling === 'WITHDRAWN').map(key));
  const seen = new Set(entries.map(identity));
  const added = [];
  const counts = { added: 0, 'skipped-not-head': 0, 'skipped-duplicate': 0, 'skipped-invalid': 0 };
  for (const request of requests) {
    const ref = bareRef(request.ref), sha = shaKey(request.sha), approval = approved.get(key(request));
    const ruling = approval?.ruling;
    if (withdrawn.has(key(request))) { counts['skipped-invalid']++; continue; }
    if (!Array.isArray(request.findings) || approval?.findingsHash !== findingsHash(request.findings)) {
      counts['skipped-invalid']++; continue;
    }
    // Match the store/gate's accepted R-number syntax. Request ruling/findings are never authority.
    if (!validRef(ref) || !validSha(sha) || typeof ruling !== 'string' || !/^R\d+[a-z]?(?:\+R\d+[a-z]?)*$/.test(ruling)
      || ruling.split('+').some(id => !new RegExp(`\\*\\*${id}\\*\\*|\\b${id}\\b[^\\n]*\\(20\\d\\d-`).test(rulings))) {
      counts['skipped-invalid']++; continue;
    }
    let entry = { ref, sha, ruling };
    if (seen.has(identity(entry))) { counts['skipped-duplicate']++; continue; }
    try {
      const head = headOf(ref);
      if (!validSha(head)) { counts['skipped-not-head']++; continue; }
      if (sha !== shaKey(head)) {
        const fingerprint = carries(entry, head);
        if (!carriesAcross(fingerprint, fingerprint)) { counts['skipped-not-head']++; continue; }
        entry = { ...entry, fingerprint };
      }
      const audit = latestAudit(sha);
      if (!audit || shaKey(audit.head) !== sha || shaKey(audit.base) === sha
        || audit.questionHash !== QUESTION_HASH || audit.verdict !== 'WEAKENED'
        || typeof audit.at !== 'string'
        || !findAudit([audit], { head: audit.head, base: audit.base, questionHash: QUESTION_HASH })) throw Error('no canonical WEAKENED audit');
      // The approval covers exactly the findings quoted in the request for this sha; an audit that says anything
      // else (a replacement finding) is not covered and grants no waiver.
      if (!Array.isArray(request.findings) || JSON.stringify(request.findings) !== JSON.stringify(audit.findings)) throw Error('audit findings differ from the approved request');
      entry = { ...entry, findings: request.findings, actor: 'record-waivers', quote: ruling, at: now };
      if (!validateEntry(entry)) throw Error('incomplete canonical findings');
    } catch { counts['skipped-invalid']++; continue; }
    seen.add(identity(entry));
    added.push(entry);
  }
  counts.added = added.length;
  return { entries: added, counts };
}

/** Thin IO boundary. Readers/remote execution/fingerprints can be injected in hermetic fixtures. */
export function recordWaivers({ env = process.env, repo = process.cwd(), path = storePath(env),
  read = file => fs.readFileSync(file, 'utf8'), exec = spawnSync, fingerprint = netDiffFingerprint,
  headOf, carries, latestAudit, append = appendEntry, readEntries = () => readStore({ path,
    warn: message => { throw Error(message); } }), now = () => new Date(), log = console.log } = {}) {
  const handoff = join(env.HOME, 'workspace/.operations/handoff');
  const boundedRead = file => {
    const body = String(read(file));
    if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw Error(`Input exceeds 16 MiB: ${file}; archive old records and retry`);
    return body;
  };
  const lines = file => boundedRead(file).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  // Read all evidence before any append. Unreadable or malformed input refuses the entire run.
  const approvals = lines(join(handoff, 'waiver-approvals.jsonl'));
  const requests = lines(join(handoff, 'waiver-requests.jsonl'));
  const rulings = boundedRead(join(handoff, 'rulings.md'));
  const audits = lines(join(env.HOME, 'workspace/.operations/coordination/audits.jsonl'));
  const store = readEntries();
  if (store.error) throw Error(`Cannot read waiver store: ${store.error}; restore readability and retry`);
  let heads, headError;
  const remoteHead = ref => {
    if (headError) throw headError;
    if (!heads) {
      try {
        const result = exec('git', ['-C', repo, 'ls-remote', '--heads', 'origin'],
          { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
        if (result.error || result.status !== 0) throw Error('origin head lookup failed');
        const found = new Map();
        for (const line of String(result.stdout ?? '').split(/\r?\n/).filter(Boolean)) {
          const match = /^([a-f0-9]{40})\s+refs\/heads\/(.+)$/i.exec(line);
          if (!match) throw Error('malformed origin head lookup');
          found.set(match[2], match[1]);
        }
        heads = found;
      } catch (error) { headError = error; throw error; }
    }
    return heads.get(ref) ?? null;
  };
  const result = recordEntries({ approvals, requests, rulings, entries: store.entries,
    latestAudit: latestAudit ?? (sha => audits.findLast(a => shaKey(a.head) === sha) ?? null),
    headOf: headOf ?? remoteHead,
    carries: carries ?? ((entry, head) => {
      const recorded = fingerprint(repo, 'origin/main', entry.sha);
      const current = fingerprint(repo, 'origin/main', head);
      return carriesAcross(recorded, current) ? recorded : null;
    }),
    now: new Date(now()).toISOString() });
  for (const entry of result.entries) {
    // Dedupe again inside appendEntry's shared append/prune lock to cover concurrent recorders.
    if (append(entry, { path, now: entry.at, dedupe: true }) === null) {
      result.counts.added--; result.counts['skipped-duplicate']++;
    }
  }
  log(Object.entries(result.counts).map(([name, count]) => `${name}=${count}`).join(' '));
  if (result.counts['skipped-invalid'] || result.counts['skipped-not-head'])
    log('Skipped evidence grants no waiver. Check approvals, current origin heads and local commit objects, then retry.');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw Error('usage: ruled-weakened-record.mjs (run in the target repository)');
    recordWaivers();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
