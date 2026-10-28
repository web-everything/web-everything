import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { MINUTE, HOUR } from '../health-watch-core.mjs';

const DEFAULT_MAX_MS = 2 * HOUR;
const RECOMMENDATION = 'Inspect the owning daemon rebuild logs and repair its refresh/rebuild path; do not reset the clone by hand.';

export function createStateLister({ readdir = readdirSync, read = readFileSync, directory = join(homedir(), '.claude', 'daemon-self-sync-state') } = {}) {
  return () => {
    let names;
    try {
      names = readdir(directory);
    } catch (error) {
      // Fail closed: a missing or unreadable state directory is its own breach, never silence or a thrown (skipped) evaluation.
      return [{ cloneKey: 'state-directory', raw: null }];
    }
    return names.filter((name) => name.endsWith('.rebuild.json')).map((name) => {
      let raw = null;
      try { raw = read(join(directory, name), 'utf8'); } catch { /* Report unreadable state. */ }
      return { cloneKey: name.slice(0, -'.rebuild.json'.length), raw };
    });
  };
}

const io = {
  listStates: createStateLister(),
  mergesSince(sha) {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const output = execFileSync('git', [
      '-C', repoRoot, 'log', '--first-parent', '--format=%H%x09%ct%x09%s', `${sha}..origin/main`,
    ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    return output.split('\n').filter(Boolean).map((line) => {
      const [commitSha, ct, ...subject] = line.split('\t');
      const ctMs = Number(ct) * 1000;
      if (!ct || !Number.isFinite(ctMs)) throw new Error('Unreadable merge timestamp');
      return { sha: commitSha, ctMs, subject: subject.join('\t') };
    });
  },
};

function adoptedMainSha(raw) {
  try {
    const sha = JSON.parse(raw)?.adopted?.mainSha;
    return typeof sha === 'string' && /^[a-f\d]{40}(?![\s\S])/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Pure decision over state records enriched with `merges` (or `mergeReadFailed`). */
export function decide({ states, now, maxMs = DEFAULT_MAX_MS }) {
  return states.map(({ cloneKey, raw, merges, mergeReadFailed }) => {
    const adoptedSha = adoptedMainSha(raw);
    const unreadable = !adoptedSha || mergeReadFailed || !Array.isArray(merges)
      || merges.some((merge) => !merge || !Number.isFinite(merge.ctMs) || typeof merge.subject !== 'string');
    const base = {
      subject: `daemon-build:${cloneKey}`,
      recommendation: `${cloneKey}: ${RECOMMENDATION}`,
    };
    if (unreadable) {
      return {
        ...base,
        breach: true,
        measure: { behind: null, oldestAgeMin: null, prs: [], adoptedMainSha: adoptedSha, at: now },
        summary: `daemon clone ${cloneKey}: state unreadable.`,
      };
    }
    const behind = merges.length;
    const oldestMs = merges.reduce((oldest, merge) => Math.min(oldest, merge.ctMs), Infinity);
    const age = behind ? Math.max(0, now - oldestMs) : 0;
    const ageLabel = age >= HOUR
      ? `${Math.floor(age / HOUR)} hours ${Math.floor((age % HOUR) / MINUTE)} minutes`
      : `${Math.floor(age / MINUTE)} minutes`;
    const prs = [...new Set(merges.flatMap(({ subject }) => {
      const match = /^Merge pull request #(\d+) from /.exec(subject);
      return match ? [Number(match[1])] : [];
    }))].sort((a, b) => a - b);
    const displayedPrs = prs.slice(0, 15).map((pr) => `#${pr}`).join(', ');
    const prSummary = `${displayedPrs || 'none'}${prs.length > 15 ? ` +${prs.length - 15} more` : ''}`;
    return {
      ...base,
      breach: behind > 0 && age > maxMs,
      measure: { behind, oldestAgeMin: Math.round(age / MINUTE), prs, adoptedMainSha: adoptedSha, at: now },
      summary: `daemon clone ${cloneKey} is ${behind} merge(s) behind origin/main; oldest missing merge ${ageLabel} old; PRs: ${prSummary}.`,
    };
  });
}

export function evaluate(probes, ctx) {
  const source = ctx.io ?? io;
  const states = source.listStates().map((state) => {
    const sha = adoptedMainSha(state.raw);
    if (!sha) return state;
    try {
      return { ...state, merges: source.mergesSince(sha) };
    } catch {
      return { ...state, mergeReadFailed: true };
    }
  });
  return decide({ states, now: ctx.now, maxMs: ctx.config?.daemonBuildStaleMaxMs ?? DEFAULT_MAX_MS });
}

export default {
  id: 'daemon-build-stale',
  scope: 'host',
  cadence: 'every-tick',
  probes: [],
  openAfter: 1,
  closeAfter: 1,
  severity: 'high',
  action: 'alert',
  recommendationHint: 'A daemon build has not adopted origin/main within the configured age limit. Inspect its rebuild logs.',
  evaluate,
};
