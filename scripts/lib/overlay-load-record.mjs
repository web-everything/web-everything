/** Best-effort coordination audit for every manual daemon overlay load. */
import filesystem from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactDetail } from './daemon-rebuild/smoke-classify/redact-detail.mjs';

const SETTINGS = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'prototype-load.json');
export const MAX_LOAD_RECORD_BYTES = 16_384;

/** Scrub before bounding: truncating first can leave a short, unrecognizable secret fragment. */
export function sanitize(value) {
  return redactDetail(String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, (c) => /\s/u.test(c) ? c : '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/gi, (url) => `${url.slice(0, url.indexOf('://') + 3)}<redacted>@`)
    .replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi, '$1 <redacted>')
    .replace(/\b(token|secret|password|passwd|api[_-]?key|authorization)(\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi, '$1$2<redacted>')
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1<redacted>')
    // Token-like runs only (mixed letters and digits, no path/branch separators) so refs and clone paths stay readable.
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, (run) => (/\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run)) || /^[0-9a-f]{32,}$/i.test(run) ? '<redacted>' : run)
    .replace(/[\p{Cc}\p{Cf}]/gu, ''));
}

/** Returns path + pathSource even on write failure; an oversized record keeps its core outcome
 * and marks detailsTruncated. Operators can inspect the load's --json output for full details. */
export function appendLoadRecord({ record, env = process.env, fs = filesystem, now = Date.now } = {}) {
  let path;
  let pathSource;
  try {
    const override = env.WE_PROTOTYPE_LOAD_RECORD;
    pathSource = typeof override === 'string' && override.trim()
      ? 'env:WE_PROTOTYPE_LOAD_RECORD' : 'settings:prototype-load.json#recordPath';
    path = pathSource.startsWith('env:') ? override : JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).recordPath;
    if (typeof path !== 'string' || !path.trim()) throw new Error('Missing prototype-load recordPath');
    if (path === '~' || path.startsWith('~/')) {
      if (!env.HOME) throw new Error('HOME required to expand recordPath');
      path = join(env.HOME, path.slice(2));
    }
    const row = { ...record, at: new Date(now()).toISOString(), source: 'daemon-load-overlay', pathSource };
    const encode = (value) => `${JSON.stringify(value, (_key, v) => typeof v === 'string'
      ? sanitize(v) : v)}\n`;
    let line = encode(row);
    if (Buffer.byteLength(line) > MAX_LOAD_RECORD_BYTES) {
      const scalar = (v) => typeof v === 'string' ? sanitize(v).slice(0, 160)
        : ['number', 'boolean'].includes(typeof v) ? v : null;
      line = encode({ at: row.at, source: row.source, clone: scalar(row.clone), ref: scalar(row.ref), pr: scalar(row.pr),
        outcome: scalar(row.outcome), registered: scalar(row.registered), adopted: scalar(row.adopted), rolledBack: scalar(row.rolledBack),
        error: scalar(row.error), triggerError: scalar(row.triggerError), pathSource, detailsTruncated: true });
    }
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.appendFileSync(path, line, 'utf8');
    return { ok: true, path, pathSource };
  } catch (e) {
    return { ok: false, error: sanitize(e?.message ?? e), path, pathSource };
  }
}
