/** Bounded, injectable reads only. Missing evidence remains operator-visible. */
import { opendirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { operatorGh } from './judge-sweep-facts-io.mjs';
import { daemonEventsPath } from '../lib/daemon-events.mjs';
import { redTeamStatusDir } from '../lib/drain-red-team-evidence.mjs';
import { fixLoopLedgerPath } from '../conveyor/fix-loop-ledger.mjs';
import { verdictLedgerPath } from '../lib/verdict-ledger.mjs';
import { feedPath } from './needs-you-feed.mjs';
import { tailFile, readPlistAsJson, extractDaemonSpec } from './daemon-status-io.mjs';
const MAX_BYTES = 256 * 1024;
const expand = path => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
function sourcePaths({ repo, env }) {
  const paths = {};
  for (const [name, label] of Object.entries({ review: 'com.we.review-daemon', fix: 'com.we.fix-dispatch-daemon', drain: 'com.plateau.drain-daemon' })) {
    paths[name] = () => extractDaemonSpec(label, readPlistAsJson(join(env.WE_LAUNCH_AGENTS_DIR || join(homedir(), 'Library', 'LaunchAgents'), `${label}.plist`))).logPath;
  }
  return { ...paths, 'daemon-events': () => daemonEventsPath({ env }), 'needs-you': () => feedPath({ env }),
    'prototype-loads': () => expand(JSON.parse(readFileSync(new URL('../settings/prototype-load.json', import.meta.url), 'utf8')).recordPath),
    'fix-loop-ledger': () => fixLoopLedgerPath(env), 'review-ledger': () => verdictLedgerPath(repo) };
}
/** Iteration stops at a fixed directory budget; no unbounded readdir or file read. */
function redStatuses({ repo, pr, env, tail }) {
  const dir = redTeamStatusDir(env), handle = opendirSync(dir), rows = [];
  try {
    let entry, count = 0;
    while ((entry = handle.readSync())) {
      if (++count > 2048) throw Error('status directory bound; inspect full directory');
      if (!entry.name.startsWith(`${encodeURIComponent(repo)}-${pr}-`) || !entry.name.endsWith('.json')) continue;
      const data = tail(join(dir, entry.name), { maxBytes: MAX_BYTES });
      if (!data || data.error || data.truncated) throw Error('status unreadable');
      const row = JSON.parse(data.text);
      if (rows.length >= 32) throw Error('matching status bound; inspect full directory');
      rows.push({ ...row, observed: data.mtimeMs });
    }
  } finally { handle.closeSync(); }
  return rows.sort((a, b) => a.observed - b.observed).map(r => JSON.stringify(r)).join('\n');
}
export function createPrTraceReader({ gh = operatorGh, now = Date.now, env = process.env,
  paths = sourcePaths, tail = tailFile, readStatuses = redStatuses } = {}) {
  return ({ pr, repo, loopThreshold = 10 }) => {
    if (!Number.isSafeInteger(pr) || pr < 1 || !/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.length > 200
      || !Number.isSafeInteger(loopThreshold) || loopThreshold < 2) throw Error('pr-trace: invalid PR, repo or loop-threshold');
    const facts = { pr, repo, loopThreshold, now: now(), live: null, sources: {}, unavailable: [], incomplete: [] };
    const readGh = args => JSON.parse(gh(args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 }));
    try {
      const p = readGh(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,labels,statusCheckRollup,reviews,isDraft']);
      if (!/^[a-f0-9]{40}$/i.test(p?.headRefOid) || !Array.isArray(p.labels) || !Array.isArray(p.reviews) || !Array.isArray(p.statusCheckRollup)) throw Error('incomplete PR');
      facts.live = p;
    } catch { facts.unavailable.push('github'); }
    try {
      const [owner, name] = repo.split('/');
      const result = readGh(['api', 'graphql', '-f', 'query=query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){mergeQueueEntry{position state}}}}',
        '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `pr=${pr}`]);
      const p = result?.data?.repository?.pullRequest;
      if (result.errors || !p || !Object.hasOwn(p, 'mergeQueueEntry')) throw Error('queue unreadable');
      if (facts.live) facts.live.mergeQueueEntry = p.mergeQueueEntry;
    } catch { facts.unavailable.push('merge-queue'); }
    let resolved = {};
    try { resolved = paths({ repo, pr, env }); } catch { facts.unavailable.push('source paths'); }
    for (const [name, resolve] of Object.entries(resolved)) {
      try {
        const path = typeof resolve === 'function' ? resolve() : resolve;
        if (!path) throw Error('unresolved');
        const data = tail(path, { maxBytes: MAX_BYTES });
        if (!data || data.error) throw Error('unreadable');
        let lines = data.text.split('\n');
        if (data.truncated) lines.shift();
        if (data.truncated || lines.length > 2000) facts.incomplete.push(`${name}: bounded tail; inspect full source if needed`);
        facts.sources[name] = lines.slice(-2000).join('\n');
      } catch { facts.unavailable.push(name); }
    }
    try { facts.sources['red-team-status'] = readStatuses({ repo, pr, env, tail }); }
    catch { facts.unavailable.push('red-team-status'); }
    return facts;
  };
}
