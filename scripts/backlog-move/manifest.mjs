/** D18 pure snapshot manifests: deterministic UTF-8 transforms and SHA-256 byte evidence. */
import { createHash } from 'node:crypto';
import { classifyCard, splitCard } from '../backlog-placement-trial.mjs';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const states = ['snapshot', 'copy', 'verify', 'cutover', 'reconcile-links', 'done', 'quarantined'];
const idPattern = /^[a-z0-9]+$/;
export function cardId(sourcePath) {
  const match = /^backlog\/([a-z0-9]+)-[a-z0-9_-]+\.md$/.exec(sourcePath);
  if (!match) throw new Error('Invalid source path; inspect snapshot');
  return match[1];
}
export function transform(bytes, destId, bornAs) {
  const text = Buffer.from(bytes).toString('utf8'), { front } = splitCard(text);
  if (front === null || !Buffer.from(text).equals(Buffer.from(bytes)) || !idPattern.test(destId) || !/^we:#[a-z0-9]+$/.test(bornAs))
    throw new Error('Invalid card bytes or identity; inspect snapshot');
  if (/^(id|formerly):[ \t]*[>|]/m.test(front) || /^(id|formerly):[^\r\n]*\r?\n[ \t]+\S/m.test(front))
    throw new Error('Multiline identity requires operator inspection');
  const newline = text.startsWith('---\r\n') ? '\r\n' : '\n';
  const clean = front.split(/\r?\n/).filter((line) => !/^(id|formerly):/.test(line)).join(newline);
  const end = text.indexOf(`${newline}---`, 3) + newline.length;
  return Buffer.from(`---${newline}id: ${JSON.stringify(destId)}${newline}formerly: ${JSON.stringify(bornAs)}${newline}${clean}${newline}${text.slice(end)}`);
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
