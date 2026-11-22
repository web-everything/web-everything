/** Shared, non-throwing admission over the existing free-scope snapshot and assessor. Every unknown input fails closed. */
import { posix } from 'node:path';
import { assessFreeScope, qualifyFile, partitionRegistry, DEFAULT_TTL_HOURS } from './free-scope.mjs';
import { collectFreeScope } from './free-scope-io.mjs';
import { CONSTELLATION_REPOS, repoKeyForSlug } from '../lib/constellation-repos.mjs';

/** The latest instant a `Date` can hold; an expiry past it cannot be rendered by the assessor. */
const MAX_TIME_MS = 8.64e15;
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * One scope entry in the assessor's canonical form `<repo key>:<normalized path>`. Refuses (throws) a blank or empty
 * entry, an unknown repo, a comma or control character, and a path escaping the repo. A repo root stays `we:` (never
 * `we:.`): the assessor matches the empty path as covering every descendant.
 */
export function canonicalScope(raw) {
  if (typeof raw !== 'string') throw new TypeError('scope entry must be a string');
  const qualified = qualifyFile(raw);
  if (!qualified) throw new Error(`empty scope entry: ${JSON.stringify(raw)}`);
  const colon = qualified.indexOf(':');
  const name = qualified.slice(0, colon);
  // `qualifyFile` has already mapped the short aliases; a full gh slug or an internal key resolves here.
  const key = repoKeyForSlug(name);
  if (!key || !Object.hasOwn(CONSTELLATION_REPOS, key)) throw new Error(`scope names an unknown repository "${name}": ${raw}`);
  const rest = qualified.slice(colon + 1);
  if (CONTROL.test(rest) || rest.includes(',')) throw new Error(`scope path holds a comma or control character: ${JSON.stringify(raw)}`);
  const path = posix.normalize(rest || '.');
  if (path === '..' || path.startsWith('../') || path.startsWith('/')) throw new Error(`scope path escapes the repo: ${raw}`);
  return `${key}:${path === '.' ? '' : path}`;
}
/** Kept for callers of the earlier name; `canonicalScope` is the one implementation. */
export const normalizeQualified = canonicalScope;

const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const inRange = ms => Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME_MS;

/** A persisted claim must be well formed AND have an expiry the partitioner can compute; anything else is corrupt. */
function validateEntry(entry) {
  const startedMs = Date.parse(entry?.startedAt);
  if (!entry || typeof entry !== 'object' || typeof entry.agent !== 'string' || !entry.agent.trim()
    || !Array.isArray(entry.files) || !entry.files.length || entry.files.some(f => typeof f !== 'string' || !f.trim())
    || !Number.isFinite(startedMs)
    || (entry.owner !== undefined && typeof entry.owner !== 'string')
    || (entry.ttlHours !== undefined && !positive(entry.ttlHours))
    || (entry.staleAfterMinutes !== undefined && !positive(entry.staleAfterMinutes))
    || (entry.lastSeenAt !== undefined && !Number.isFinite(Date.parse(entry.lastSeenAt)))) {
    throw new Error('corrupt scope registry entry');
  }
  // Overflow (`ttlHours: 1e308`) would make the partitioner read a live claim as stale: refuse, never ignore.
  if (!inRange(startedMs + (entry.ttlHours ?? DEFAULT_TTL_HOURS) * 3600e3)) throw new Error('corrupt scope registry entry: expiry out of range');
  if (entry.staleAfterMinutes !== undefined) {
    const seen = Number.isFinite(Date.parse(entry.lastSeenAt)) ? Date.parse(entry.lastSeenAt) : startedMs;
    if (!inRange(seen + entry.staleAfterMinutes * 60e3)) throw new Error('corrupt scope registry entry: heartbeat out of range');
  }
}

/**
 * An open PR with every path qualified `<repo key>:<path>` here. The inherited holder builder re-qualifies each raw path
 * by splitting at its first colon, so a file such as `docs/a:b.md` would be read as repo `docs/a` and hold nothing.
 */
function qualifyPr(pr) {
  const key = typeof pr?.repo === 'string' ? repoKeyForSlug(pr.repo) : null;
  if (!key || !Object.hasOwn(CONSTELLATION_REPOS, key)) throw new Error('incomplete scope snapshot: open PR from an unknown repository');
  const list = value => {
    if (!Array.isArray(value) || value.some(f => typeof f !== 'string' || !f)) throw new Error(`incomplete scope snapshot: PR #${pr.number} has no usable file list`);
    return value.map(f => `${key}:${f}`);
  };
  return { ...pr, files: list(pr.files), ...(pr.added === undefined ? {} : { added: list(pr.added) }) };
}

export function checkScope({ declaredFiles, excludeAgent, excludeOwner, collect = collectFreeScope, now = Date.now } = {}) {
  try {
    const declared = Array.isArray(declaredFiles) ? declaredFiles : typeof declaredFiles === 'string' ? declaredFiles.split(',') : null;
    if (!declared) throw new TypeError('no scope declared');
    const files = [...new Set(declared.map(canonicalScope))];
    if (!files.length) throw new Error('no scope declared');
    // The inherited exclusion matches by name alone when no owner is given, which could hide another owner's claim.
    const excluding = excludeAgent !== undefined && excludeAgent !== null && excludeAgent !== '';
    if (excluding && (typeof excludeAgent !== 'string' || !excludeAgent.trim() || typeof excludeOwner !== 'string' || !excludeOwner.trim())) {
      throw new Error('excludeAgent needs a non-empty excludeOwner');
    }
    const nowMs = typeof now === 'function' ? now() : now;
    if (!Number.isFinite(nowMs)) throw new Error('invalid clock reading');
    // Read exactly the repositories the scope names: PRs in another repo cannot hold these files, and a repo left unread cannot clear them.
    const repos = [...new Set(files.map(file => CONSTELLATION_REPOS[file.slice(0, file.indexOf(':'))].slug))];
    const snapshot = collect({ files: files.join(','), repos, requireRegistry: true, now: () => nowMs });
    if (!snapshot || !Array.isArray(snapshot.prs) || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.unreadable)
      || !Array.isArray(snapshot.repos) || repos.some(repo => !snapshot.repos.includes(repo))) {
      throw new Error('incomplete scope snapshot');
    }
    if (snapshot.status === 'unknown') throw new Error('unknown scope snapshot');
    // Validate each persisted claim, then canonicalize its files the same way (an empty or escaping claim = refuse).
    const agents = snapshot.agents.map(entry => {
      try { validateEntry(entry); return { ...entry, files: entry.files.map(canonicalScope) }; }
      // Name the holder so an operator can clean the entry (e.g. one registered under an unknown repo key).
      catch (error) { throw new Error(`${error.message} (registry entry for agent ${JSON.stringify(entry?.agent)})`); }
    });
    const prs = snapshot.prs.map(qualifyPr);
    const verdict = assessFreeScope({ files, prs, agents, unreadable: snapshot.unreadable, nowMs,
      ...(excluding ? { excludeAgent, excludeOwner } : {}) });
    const { live } = partitionRegistry(agents, nowMs);
    const overlaps = verdict.files.filter(row => row.state === 'occupied').flatMap(row => row.holders.map(holder => {
      if (holder.type === 'pr') return { file: row.file, pr: { number: holder.number, repo: holder.repo } };
      const entry = live.find(e => e.agent === holder.agent);
      return { file: row.file, agent: holder.agent,
        ...(entry?.lane !== undefined ? { lane: entry.lane } : {}), ...(entry?.item !== undefined ? { item: entry.item } : {}) };
    }));
    const unreadable = snapshot.unreadable;
    return { ok: verdict.status === 'free' && !unreadable.length, overlaps,
      ...(!unreadable.length ? {} : { unreadable }),
      ...(verdict.status === 'free' && !unreadable.length ? {} : { reason: verdict.headline }) };
  } catch (error) {
    return { ok: false, overlaps: [], reason: `scope check failed: ${error?.message || String(error)}` };
  }
}
