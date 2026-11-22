/** D18 pure snapshot manifests: deterministic UTF-8 transforms and SHA-256 byte evidence. */
import { createHash } from 'node:crypto';
import { classifyCard, splitCard } from '../backlog-placement-trial.mjs';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const states = ['snapshot', 'copy', 'verify', 'cutover', 'reconcile-links', 'done', 'quarantined'];
const idPattern = /^[a-z0-9]+$/;
// U+2028/U+2029 built from code points so no literal separator ever sits in this source.
const separators = [0x2028, 0x2029].map((code) => String.fromCharCode(code));
export function cardId(sourcePath) {
  const match = /^backlog\/([a-z0-9]+)-[a-z0-9_-]+\.md$/.exec(sourcePath);
  if (!match) throw new Error('Invalid source path; inspect snapshot');
  return match[1];
}
export function transform(bytes, destId, bornAs) {
  const text = Buffer.from(bytes).toString('utf8'), { front } = splitCard(text);
  if (front === null || !Buffer.from(text).equals(Buffer.from(bytes)) || !idPattern.test(destId) || !/^we:#[a-z0-9]+$/.test(bornAs))
    throw new Error('Invalid card bytes or identity; inspect snapshot');
  // Only LF and CRLF are line endings here: a bare CR or a Unicode line separator would hide an id line from the filter below.
  if (/\r(?!\n)/.test(front) || separators.some((s) => front.includes(s))) throw new Error('Unsupported line ending in frontmatter; inspect snapshot');
  if (/^(id|formerly):[ \t]*[>|]/m.test(front) || /^(id|formerly):[^\r\n]*\r?\n[ \t]+\S/m.test(front))
    throw new Error('Multiline identity requires operator inspection');
  // Same delimiters splitCard parsed: opening/closing line endings may differ (mixed CRLF/LF), so capture each.
  const parts = /^---(\r?\n)([\s\S]*?)(\r?\n)---([\s\S]*)$/.exec(text);
  if (!parts || parts[2] !== front) throw new Error('Invalid card bytes or identity; inspect snapshot');
  const [, open, , close, rest] = parts;
  const identityLine = (line) => /^(id|formerly):/.test(line);
  const lines = front.split(/(?<=\n)/);
  let clean = lines.filter((line) => !identityLine(line)).join('');
  // An unterminated last line that is dropped leaves the previous line's ending ahead of the closing delimiter's own.
  const last = lines.at(-1);
  if (identityLine(last) && !/\n$/.test(last)) clean = clean.replace(/\r?\n$/, '');
  return Buffer.from(`---${open}id: ${JSON.stringify(destId)}${open}formerly: ${JSON.stringify(bornAs)}${clean === '' ? '' : `${open}${clean}`}${close}---${rest}`);
}
export function buildManifest({ sourceSha, cards }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !Array.isArray(cards) || !cards.length) throw new Error('Pinned sourceSha and snapshots required');
  const seen = new Set();
  const rows = cards.map(({ sourcePath, bytes, destId = cardId(sourcePath) }) => {
    const bornAs = `we:#${cardId(sourcePath)}`, trial = classifyCard(Buffer.from(bytes).toString('utf8'));
    if (trial.target !== 'plateau-app') throw new Error(`Refused classification ${trial.target}; inspect trial, never route unsure`);
    if (seen.has(destId)) throw new Error('Duplicate destination id; create a new manifest');
    seen.add(destId);
    return { bornAs, sourcePath, sourceDigest: digest(bytes), destId,
      destPath: sourcePath.replace(/^backlog\/[a-z0-9]+-/, `backlog/${destId}-`),
      destDigest: digest(transform(bytes, destId, bornAs)), classification: trial.target, rule: trial.rule,
      state: 'snapshot', result: null, quarantineReason: null };
  }).sort((a, b) => a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0);
  if (new Set(rows.map((r) => r.bornAs)).size !== rows.length) throw new Error('Duplicate source identity');
  return { manifestId: digest(JSON.stringify({ sourceSha, cards: rows })).slice(0, 24), sourceSha, cards: rows };
}
export function verifyManifest(manifest, snapshots) {
  if (!manifest || !Array.isArray(manifest.cards)) throw new Error('Incomplete manifest');
  const rebuilt = buildManifest({ sourceSha: manifest.sourceSha, cards: manifest.cards.map((r) => {
    const snapshot = snapshots.find((s) => s.sourcePath === r.sourcePath);
    if (!snapshot) throw new Error('Missing snapshot; inspect sourceSha');
    return { ...snapshot, destId: r.destId };
  }) });
  for (const row of manifest.cards) {
    const expected = rebuilt.cards.find((r) => r.sourcePath === row.sourcePath);
    for (const key of ['bornAs', 'sourcePath', 'sourceDigest', 'destId', 'destPath', 'destDigest', 'classification', 'rule'])
      if (row[key] !== expected[key]) throw new Error(`Manifest ${key} mismatch (digest/identity); refused`);
    if (!states.includes(row.state) || !Object.hasOwn(row, 'result') || !Object.hasOwn(row, 'quarantineReason')) throw new Error('Incomplete manifest state');
  }
  if (manifest.manifestId !== rebuilt.manifestId) throw new Error('Manifest identity digest mismatch');
  return true;
}
