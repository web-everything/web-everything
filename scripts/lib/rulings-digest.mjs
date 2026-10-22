import { homedir } from 'node:os';
import { readDeclaredSettings } from './settings-files.mjs';

export const DEFAULT_DIGEST_PATH = '~/workspace/.operations/handoff/rulings.md';

/** Ignore comments and malformed rows; preserve the original line for injection and edits. */
export function parseDigest(text) {
  return String(text ?? '').split(/\r?\n/).flatMap((raw) => {
    if (!raw.trim() || raw.trimStart().startsWith('#')) return [];
    const fields = raw.split(' | ');
    const id = fields[0].trim();
    if (fields.length < 5 || !/^R\d+$/.test(id)) return [];
    const tags = {};
    let rule = fields.at(-1).trim();
    // Consume metadata from the end only; marker-like prose stays intact.
    while (true) {
      const enforced = /\s*→ enforced by\s+(\S+)\s*$/.exec(rule);
      if (enforced) {
        tags.enforcedBy = enforced[1];
        rule = rule.slice(0, enforced.index).trimEnd();
        continue;
      }
      const trailing = /(?:^|\s)(mem:owed|superseded-by:R\d+|codifiedIn:\S+|review:\S+|retired:\S+)\s*$/.exec(rule);
      if (!trailing) break;
      const tag = trailing[1];
      const colon = tag.indexOf(':');
      tags[tag.slice(0, colon)] = tag.slice(colon + 1);
      rule = rule.slice(0, trailing.index).trimEnd();
    }
    const pending = /\s*\(pending\)\s*$/.test(fields[2]);
    const cls = fields[2].replace(/\s*\(pending\)\s*$/, '').trim();
    return [{ id, num: Number(id.slice(1)), date: fields[1].trim(), cls, pending,
      quote: fields.slice(3, -1).join(' | ').trim(), rule, tags,
      active: !('superseded-by' in tags || 'codifiedIn' in tags || 'enforcedBy' in tags || 'retired' in tags), raw }];
  });
}

/** `settings` is the {settings, owners} result of readDeclaredSettings(). */
export function resolveDigestPath({ env = process.env, settings = readDeclaredSettings() } = {}) {
  let path = DEFAULT_DIGEST_PATH;
  let source = 'built-in';
  const configured = settings.settings?.rulings?.digestPath;
  if (typeof configured === 'string' && configured.trim()) {
    path = configured;
    source = settings.owners?.['rulings.digestPath'] ?? 'settings/rulings.json';
  }
  if (env.RULINGS_DIGEST_PATH?.trim()) {
    path = env.RULINGS_DIGEST_PATH;
    source = 'env:RULINGS_DIGEST_PATH';
  }
  return { path: path.replace(/^~(?=\/|$)/, homedir()), source };
}

export function selectForInjection(rulings, { maxLines = 40, maxBytes = 6144 } = {}) {
  const rank = (r) => r.cls.startsWith('S:') && r.pending ? 0 : r.cls === 'J' ? 1 : r.cls === 'D' ? 2 : 3;
  const active = rulings.filter((r) => r.active).sort((a, b) => rank(a) - rank(b));
  const lines = [];
  let bytes = 0;
  for (const ruling of active) {
    const size = Buffer.byteLength(ruling.raw, 'utf8') + (lines.length ? 1 : 0);
    if (lines.length >= maxLines) break;
    if (bytes + size > maxBytes) continue;
    lines.push(ruling.raw);
    bytes += size;
  }
  return { lines, overCap: lines.length < active.length, activeCount: active.length };
}
