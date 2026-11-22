/**
 * @file seat-ac-rubric.mjs — CKLST-B correctness criteria, pinned before the build.
 * Pure parsing and rubric construction; the caller supplies immutable git reads.
 * review-round-rules.acceptanceIds exposes only ids, so retain its section grammar here with text.
 */
const HEX40 = /^[0-9a-f]{40}$/;

function acceptanceSection(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex(line => /^##\s+Acceptance\b/.test(line));
  if (start < 0) return [];
  const rest = lines.slice(start + 1), end = rest.findIndex(line => /^#{1,2}\s/.test(line));
  return end < 0 ? rest : rest.slice(0, end);
}

/** PURE: keep the card's A-id and exact criterion text (no trimming or rewriting). */
export function acceptanceItems(text, { numbered = false } = {}) {
  const items = [];
  for (const line of acceptanceSection(text)) {
    const match = line.match(numbered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*]\s*\[(A\d+)\]\s+(.+)$/);
    if (!match) continue;
    items.push(numbered ? { id: `A${items.length + 1}`, text: match[1] } : { id: match[1], text: match[2] });
  }
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('duplicate pinned acceptance id');
  return items;
}

/**
 * Read only the exact merge-base. An unreadable named source throws; absence of criteria returns null.
 * A missing card path (not a failed read) or a card without criteria permits the DoR numbered-list fallback.
 */
export function buildAcceptanceRubric({ head, mergeBase, cardPath, prepPath, readFileAtRevision,
  id = 'https://everstandards.dev/core/rubrics/correctness', title = 'Pinned correctness acceptance' } = {}) {
  if (!HEX40.test(head ?? '') || !HEX40.test(mergeBase ?? '')) throw new Error('exact head and merge-base required');
  let items = cardPath ? acceptanceItems(readFileAtRevision(mergeBase, cardPath)) : [];
  if (!items.length && prepPath) items = acceptanceItems(readFileAtRevision(mergeBase, prepPath), { numbered: true });
  if (!items.length) return null;
  return { rubricType: 'https://everstandards.dev/core/rubric/v0.1', id, version: `ac-${mergeBase}`,
    title, appliesTo: { gitCommit: head }, items };
}
