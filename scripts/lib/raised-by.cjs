/** Shared synchronous core for the ESM filers and CommonJS site loader. */
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const CARD_ID = /^(?:\d{1,5}|x[a-z0-9]{6})$/;
const MENTION = /^- Also raised by ([\w.-]+\/[\w.-]+#\d+|unknown#0) \(finding (\d+): `([^`\n]+)` [—-] (.+)\)(?: · key `([^`\n]+)`)?$/;
function parseRaisedBy(text) {
  return String(text ?? '').split('\n').flatMap(line => {
    const m = MENTION.exec(line.trim());
    return m ? [{ source: m[1], finding: Number(m[2]), anchor: m[3], claim: m[4], key: m[5] || null, line: line.trim() }] : [];
  });
}
// A filing key can cover several findings: retain each finding within that filing.
const raisedByKey = r => JSON.stringify(r.key ? [r.key, r.finding] : [r.source, r.finding, r.anchor, r.claim]);
function mergeRaisedBy(...lists) {
  return [...new Map(lists.flat().map(r => [raisedByKey(r), r])).values()];
}
function raisedByFile(cardId, line) {
  if (!CARD_ID.test(String(cardId))) throw new Error('invalid raised-by parent card id');
  const records = parseRaisedBy(line);
  if (records.length !== 1 || records[0].line !== String(line).trim() || String(line).trim().includes('\n')) throw new Error('invalid raised-by format');
  const r = records[0];
  const hash = createHash('sha256').update(raisedByKey(r)).digest('hex').slice(0, 24);
  return { path: `backlog/raised-by/${cardId}/${r.source.split('#')[1]}-${hash}.md`, content: `${r.line}\n` };
}
function list(dir) {
  try { return readdirSync(dir).sort(); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
// Numbering stamps bornAs in frontmatter and leaves per-raise paths immutable.
// Share the alias rule with both filesystem and PR-hosted readers.
function raisedByParentIds(cardId, body, bornAs) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(body ?? ''))?.[1] ?? '';
  const alias = bornAs ?? /^bornAs:[ \t]*(["']?)(x[a-z0-9]{6})\1[ \t]*\r?$/m.exec(fm)?.[2];
  return [...new Set([String(cardId), /^x[a-z0-9]{6}$/.test(String(alias)) ? String(alias) : null]
    .filter(id => id !== null && CARD_ID.test(id)))];
}
function readRaisedBy(cardId, root, { body, bornAs, backlogDir = join(root, 'backlog') } = {}) {
  if (!CARD_ID.test(String(cardId))) return parseRaisedBy(body);
  let parents = [];
  if (body === undefined) {
    const names = list(backlogDir).filter(n => n.endsWith('.md'));
    parents = names.filter(n => n.startsWith(`${cardId}-`))
      .map(n => ({ id: n.split('-')[0], body: readFileSync(join(backlogDir, n), 'utf8') }));
    // A caller can still hold the birth ID after numbering. Only that fallback
    // needs a corpus scan; site rendering supplies the current ID and body.
    if (!parents.length && /^x/.test(String(cardId))) {
      parents = names.map(n => ({ id: n.split('-')[0], body: readFileSync(join(backlogDir, n), 'utf8') }))
        .filter(p => raisedByParentIds(p.id, p.body).includes(String(cardId)));
    }
  } else parents = [{ id: String(cardId), body }];
  const ids = new Set([String(cardId), ...parents.flatMap(p => raisedByParentIds(p.id, p.body, bornAs))]);
  const legacy = parents.flatMap(p => parseRaisedBy(p.body));
  const records = [...ids].flatMap(id => {
    const dir = join(backlogDir, 'raised-by', id);
    return list(dir).filter(n => n.endsWith('.md')).flatMap(n => parseRaisedBy(readFileSync(join(dir, n), 'utf8')));
  });
  return mergeRaisedBy(legacy, records);
}
function validateRaisedBy(root, { backlogDir = join(root, 'backlog') } = {}) {
  const errors = [];
  const parents = new Map();
  const ambiguous = new Set();
  for (const name of list(backlogDir).filter(n => n.endsWith('.md'))) {
    const id = name.split('-')[0];
    const body = readFileSync(join(backlogDir, name), 'utf8');
    const seen = new Set(parseRaisedBy(body).map(raisedByKey));
    // Both directories belong to one card, so duplicate checking must also span them.
    for (const alias of raisedByParentIds(id, body)) {
      if (parents.has(alias)) ambiguous.add(alias);
      else parents.set(alias, seen);
    }
  }
  for (const id of list(join(backlogDir, 'raised-by'))) {
    if (!CARD_ID.test(id) || !parents.has(id)) errors.push(`raised-by parent ${id} does not exist`);
    // Historical bornAs collisions matter only when a raise uses that parent.
    if (ambiguous.has(id)) errors.push(`raised-by parent ${id} is ambiguous`);
    // Legacy duplicates remain readable; a new file must not repeat an existing raise.
    const seen = parents.get(id) ?? new Set();
    let files;
    try { files = list(join(backlogDir, 'raised-by', id)); } catch { errors.push(`invalid raised-by directory ${id}`); continue; }
    for (const name of files) {
      const rel = `backlog/raised-by/${id}/${name}`;
      let content;
      try { content = readFileSync(join(backlogDir, 'raised-by', id, name), 'utf8'); } catch { errors.push(`${rel}: invalid format`); continue; }
      const records = parseRaisedBy(content);
      if (records.length !== 1 || content !== `${records[0].line}\n`) { errors.push(`${rel}: invalid format`); continue; }
      const key = raisedByKey(records[0]);
      if (seen.has(key)) errors.push(`${rel}: duplicate raised-by key`);
      seen.add(key);
      if (CARD_ID.test(id) && raisedByFile(id, records[0].line).path !== rel) errors.push(`${rel}: noncanonical path`);
    }
  }
  return errors;
}
/** Render one merged section, preserving every other part of the authored body. */
function withRaisedBy(body, records) {
  const clean = String(body).split('\n').filter(line => !MENTION.test(line.trim()) && line.trim() !== '## Also raised by').join('\n');
  return records.length ? `${clean.trimEnd()}\n\n## Also raised by\n\n${records.map(r => r.line).join('\n')}\n` : body;
}
module.exports = { parseRaisedBy, raisedByKey, mergeRaisedBy, raisedByFile, raisedByParentIds, readRaisedBy, validateRaisedBy, withRaisedBy };
