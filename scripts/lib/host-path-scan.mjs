/**
 * Host home path ratchet. Operator rule (2026-10-13): "no local path should be committed ever".
 * Reference host resources by name, resolved on the host through an env var or $HOME.
 * Pure scanning only; existing debt must match the baseline exactly, which may only shrink.
 */
export const HOST_PATH_RE = /\/(Users|home)\/([A-Za-z0-9_-][A-Za-z0-9._-]*)\//g;
export const PLACEHOLDER_NAMES = Object.freeze(new Set([
  ...'abcdefghijklmnopqrstuvwxyz',
  'me', 'you', 'user', 'username', 'operator', 'op', 'example', 'test', 'fixture', 'foo', 'bar',
]));

/** Return every non-placeholder occurrence, with its one-based line number. */
export function findHostPaths(content) {
  const hits = [];
  let offset = 0;
  let line = 1;
  for (const hit of content.matchAll(new RegExp(HOST_PATH_RE))) {
    line += content.slice(offset, hit.index).split('\n').length - 1;
    offset = hit.index;
    const name = hit[2];
    if (!PLACEHOLDER_NAMES.has(name.toLowerCase())) hits.push({ match: hit[0], name, line });
  }
  return hits;
}

/** Compare repo-relative documents against the exact occurrence-count baseline. */
export function scanHostPaths(docs, baseline) {
  const errors = [];
  const counts = new Map();
  for (const { file, content } of docs) {
    const hits = findHostPaths(content);
    counts.set(file, hits.length);
    const allowed = Object.hasOwn(baseline.files, file) ? baseline.files[file] : 0;
    if (hits.length > allowed) {
      const line = hits[0].line;
      errors.push({
        message: `${file}:${line}: ${hits.length} host-local path occurrence(s) (baseline: ${allowed}). Reference the host resource by NAME resolved on the host (env var / $HOME), never a literal path.`,
        descriptor: { kind: 'host-local-path', fix: 'model', file, line },
      });
    }
  }
  for (const [file, allowed] of Object.entries(baseline.files)) {
    const count = counts.get(file) ?? 0;
    if (count < allowed || count === 0) {
      errors.push({
        message: `${file}: host-local path baseline is stale (${allowed} baselined, ${count} current). Shrink the baseline entry${count === 0 ? ' by removing it' : ''}; the baseline may only shrink and must match exactly.`,
        descriptor: { kind: 'host-local-path-baseline-stale', fix: 'model', file },
      });
    }
  }
  return { errors };
}
