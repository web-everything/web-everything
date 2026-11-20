#!/usr/bin/env node
/** Prune obsolete audit waivers. --dry-run reports without writing; unknown git evidence keeps entries.
 * Uses local commit objects and origin/main; refresh them separately before pruning after remote changes.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readStore, pruneEntries, rewriteStore, storePath, withRuledWeakenedLock, waiverRepository } from './ruled-weakened-store.mjs';
import { netDiffFingerprint, carriesAcross } from '../lib/net-diff-fingerprint.mjs';

export function pruneStore({ dryRun = false, repo = process.cwd(), path = storePath(), exec = spawnSync, log = console.log, lockOptions, fingerprint = netDiffFingerprint } = {}) {
  return withRuledWeakenedLock(path, () => {
    const git = (args) => exec('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    const store = readStore({ path, warn: message => { throw Error(message); } });
    if (store.error) throw Error(`Cannot prune unreadable store: ${store.error}; restore readability and retry`);
    const refs = git(['ls-remote', '--heads', 'origin']);
    const heads = new Map();
    let lookupError = refs.status !== 0 || !!refs.error;
    for (const line of String(refs.stdout ?? '').trim().split('\n').filter(Boolean)) {
      const match = /^([a-f0-9]{40})\s+refs\/heads\/(.+)$/i.exec(line);
      if (!match) lookupError = true;
      else heads.set(match[2], match[1]);
    }
    if (lookupError) log('Ref lookup failed; keeping all entries. Restore origin access and retry.');
    const repository = waiverRepository(repo, { exec });
    if (!repository) log('Repository identity unavailable; keeping all entries. Restore origin configuration and retry.');
    else if (store.entries.some(entry => !entry.repository))
      log('Keeping legacy waivers without repository ownership; inspect their original repository before manual retirement.');
    const result = pruneEntries(store.entries, {
      repository,
      headOf: ref => { if (lookupError) throw Error('ref lookup failed'); return heads.get(ref.replace(/^refs\/heads\//, '')) ?? null; },
      isMerged: ref => {
        const head = heads.get(ref.replace(/^refs\/heads\//, ''));
        if (!head) return true;
        const probe = git(['merge-base', '--is-ancestor', head, 'origin/main']);
        if (probe.error || ![0, 1].includes(probe.status)) throw Error('merge lookup failed');
        return probe.status === 0;
      },
      carries: (entry, head) => {
        const recorded = fingerprint(repo, 'origin/main', entry.sha);
        const current = fingerprint(repo, 'origin/main', head);
        if (recorded === null || current === null) {
          log('Fingerprint lookup failed; keeping entry. Restore local commit objects and retry.');
          return null; // Unknown evidence must not become a negative carry comparison.
        }
        return carriesAcross(recorded, current);
      },
    });
    if (!dryRun && result.dropped.length) rewriteStore({ entries: result.kept, path });
    log(`${dryRun ? 'Would keep' : 'Kept'} ${result.kept.length}; ${dryRun ? 'would drop' : 'dropped'} ${result.dropped.length} audit waivers.`);
    return result;
  }, lockOptions);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--dry-run')) throw Error('usage: ruled-weakened-prune.mjs [--dry-run]');
    pruneStore({ dryRun: process.argv.includes('--dry-run') });
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
