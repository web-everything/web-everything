/** Tick-local fetch sharing for review readers. Outside the daemon tick every command is unchanged. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';

const ticks = new AsyncLocalStorage();
export function resolveReviewFetchSettings({ env = process.env, review, platform, log } = {}) {
  if (review === undefined) {
    try { review = JSON.parse(readFileSync(new URL('../review-settings.json', import.meta.url), 'utf8')); } catch { review = {}; }
  }
  const pick = v => ({ sharedPerTick: v?.fetch?.sharedPerTick });
  const raw = env.WE_REVIEW_FETCH_SHARED_PER_TICK;
  return cascadePolicy('review.fetch', pick(review), {
    standard: { sharedPerTick: true }, platform: pick(platform ?? platformPreference('review', { env })), env, log,
    envValues: { sharedPerTick: raw === 'true' ? true : raw === 'false' ? false : undefined },
    valid: { sharedPerTick: v => typeof v === 'boolean' },
  });
}

/** A fresh context is the tick id; no cache can outlive it or leak into a concurrent tick. */
export function withReviewFetchTick(run, { sharedPerTick = resolveReviewFetchSettings().value.sharedPerTick } = {}) {
  return ticks.run(sharedPerTick ? new Map() : undefined, run);
}

export function reviewFetchExec(exec = execFileSync) {
  return (cmd, args, opts = {}) => {
    const tick = ticks.getStore();
    if (!tick || cmd !== 'git' || args?.[0] !== 'fetch') return exec(cmd, args, opts);
    // Only the review readers' explicit origin-style fetches are shared. History/depth, other flags,
    // configured-default fetches and FETCH_HEAD consumers retain their original command.
    const flags = new Set(['--quiet', '-q', '--no-tags', '--no-write-fetch-head', '--end-of-options']);
    let i = 1;
    while (flags.has(args[i])) i++;
    const remote = args[i++];
    const refs = args.slice(i);
    if (!remote || remote.startsWith('-') || !refs.length || refs.some(r => r.startsWith('-') || r.includes('*')))
      return exec(cmd, args, opts);
    let cwd = resolve(opts.cwd ?? process.cwd());
    try { cwd = realpathSync(cwd); } catch { /* exec retains the original failure */ }
    const key = `${cwd}\0${remote}`;
    let state = tick.get(key);
    if (!state) {
      try {
        const fetched = String(exec('git', ['fetch', '--verbose', '--porcelain', '--no-tags', '--no-write-fetch-head', '--end-of-options', remote,
          `+refs/heads/*:refs/remotes/${remote}/*`], { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        // Porcelain lists even unchanged refs advertised by THIS fetch. A local ref listing would
        // also include deleted upstream branches and could turn a required fetch failure into success.
        const heads = new Set(fetched.split('\n').flatMap(line => {
          const match = /^[ *+=t-] [a-f0-9]+ [a-f0-9]+ (refs\/remotes\/[^\s]+)$/.exec(line);
          return match ? [match[1]] : [];
        }));
        state = { heads, extra: new Set() };
        tick.set(key, state); // failed fetches never attest coverage
      } catch {
        tick.set(key, { failed: true });
        return exec(cmd, args, opts);
      }
    }
    if (state.failed) return exec(cmd, args, opts);
    const missing = refs.filter(ref => {
      if (state.extra.has(ref)) return false;
      const [source, dest] = ref.replace(/^\+/, '').split(':');
      const branch = source.replace(/^refs\/heads\//, '');
      const tracking = `refs/remotes/${remote}/${branch}`;
      if ((!dest || dest === tracking) && state.heads.has(tracking)) return false;
      // A pinned SHA may already be in the objects the shared heads fetched.
      if (!dest && /^[a-f0-9]{40}$/i.test(source)) {
        try { exec('git', ['cat-file', '-e', `${source}^{commit}`], opts); return false; } catch { /* targeted fetch */ }
      }
      return true;
    });
    if (missing.length) {
      // Preserve the caller's flags and failure handling, but request only uncovered refs.
      const result = exec(cmd, [...args.slice(0, i), ...missing], opts);
      for (const ref of missing) state.extra.add(ref);
      return result;
    }
    return opts.encoding ? '' : Buffer.alloc(0);
  };
}

export const reviewExecFileSync = reviewFetchExec();
